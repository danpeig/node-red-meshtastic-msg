const importSync = require("import-sync"); //Synchronous module loader
const EventEmitter = require("node:events"); //Manage events
const meshtastic_core = importSync("@meshtastic/core"); //This is required because Node-RED does not support ES Modules
const meshtastic_http = importSync("@meshtastic/transport-http"); //This is required because Node-RED does not support ES Modules
const meshtastic_serial = importSync("@meshtastic/transport-node-serial"); //This is required because Node-RED does not support ES Modules
const MeshDevice = meshtastic_core.MeshDevice;
const TransportHTTP = meshtastic_http.TransportHTTP;
const TransportSerial = meshtastic_serial.TransportNodeSerial;

const connectionReady = new EventEmitter(); //Notify all nodes of a successful connection

module.exports = function (RED) {
  //-----------------------------------------------------------------------------
  //Send text messages node
  function SendText(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Initial status
    node.status({ fill: "grey", shape: "dot", text: "inactive" });

    //Check if the device is configured
    if (device) {
      //Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        // Send the message
        node.on("input", function (msg) {
          if (typeof msg.payload === "undefined" || msg.payload === null)
            msg.payload = "msg.payload not set"; //Educational
          try {
            connection
              ?.sendText(msg.payload, msg.destination, msg.wantAck, msg.channel)
              .then((id) => {
                node.status({ fill: "green", shape: "dot", text: "active" });
                node.trace("Message sent: " + msg.payload);
              })
              .catch((e) => {
                node.status({ fill: "red", shape: "dot", text: "error" });
                node.error("Failed to send message");
                node.error(e);
              });
          } catch (e) {
            node.status({ fill: "red", shape: "dot", text: "error" });
            node.error("Exception in the text message sender");
            node.error(e);
          }
        });
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-send", SendText);

  //-----------------------------------------------------------------------------
  //Receive text messages node
  function ReceiveText(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Initial status
    node.status({ fill: "grey", shape: "dot", text: "inactive" });

    //Check if the device is configured
    if (device) {
      // Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        try {
          connection.events.onMessagePacket.subscribe(function (data) {
            //Execute when a message was received
            data.payload = data.data; //Copy the text to the payload field
            node.trace("Message received >> " + data.data);
            node.status({ fill: "green", shape: "dot", text: "active" });
            node.send(data);
          });
        } catch (e) {
          node.status({ fill: "red", shape: "dot", text: "error" });
          node.error("Failed to initialize the message receive listener");
          node.error(e);
        }
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-receive", ReceiveText);

  //-----------------------------------------------------------------------------
  //Receive status node
  function DeviceStatus(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Node output
    let output = {};

    //Initial status
    output.payload = 0;
    output.text = "idle";
    node.send(output);
    node.status({ fill: "grey", shape: "dot", text: "offline" });

    //Check if the device is configured
    if (device) {
      // Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        try {

          //Connected status
          output.payload = 5;
          output.text = "connected";
          node.send(output);
          node.status({ fill: "green", shape: "dot", text: "connected" });

          connection.events.onDeviceStatus.subscribe(function (data) {
            //Execute when a message was received
            //Nice visualization of the status
            output.payload = data;
            switch (data) {
              case 1:
                node.status({
                  fill: "yellow",
                  shape: "ring",
                  text: "restarting",
                });
                break;
              case 2:
                output.text = "disconnected";
                node.status({
                  fill: "red",
                  shape: "ring",
                  text: "disconnected",
                });
              case 3:
                output.text = "connecting";
                node.status({
                  fill: "yellow",
                  shape: "ring",
                  text: "connecting",
                });
                break;
              case 4:
                output.text = "reconnecting";
                node.status({
                  fill: "yellow",
                  shape: "ring",
                  text: "reconnecting",
                });
                break;
              case 5:
                output.text = "connected";
                node.status({ fill: "green", shape: "dot", text: "connected" });
                break;
              case 6:
                output.text = "configuring";
                node.status({
                  fill: "blue",
                  shape: "ring",
                  text: "configuring",
                });
                break;
              case 7:
                output.text = "configured";
                node.status({
                  fill: "blue",
                  shape: "dot",
                  text: "configured",
                });
                break;
              case 8:
                output.text = "error";
                node.status({
                  fill: "red",
                  shape: "dot",
                  text: "error",
                });
                break;
              default:
                output.text = "unknown";
                node.status({ fill: "grey", shape: "dot", text: "unknown" });
            }
            node.send(output);
          });
        } catch (e) {
          output.payload = 8;
          output.text = "error";
          node.send(output);
          node.status({ fill: "red", shape: "dot", text: "error" });
          node.error("Failed to initialize the status listener");
          node.error(e);
        }
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-status", DeviceStatus);

  //-----------------------------------------------------------------------------
  //Receive generic event
  function ReceiveEvent(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.eventType = config.event;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Initial status
    node.status({ fill: "grey", shape: "dot", text: "inactive" });

    //Check if the device is configured
    if (device) {
      // Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        if (connection.events[node.eventType] !== undefined) {
          node.trace("Initializing event monitor: " + node.eventType);
          node.status({ fill: "green", shape: "dot", text: "active" });
          try {
            connection.events[node.eventType].subscribe(function (data) {
              node.status({ fill: "green", shape: "dot", text: "active" });
              //Forward the data directly to the output
              node.send(data);
            });
          } catch (e) {
            node.status({ fill: "red", shape: "dot", text: "error" });
            node.error("Failed to initialize the event monitor");
            node.error(e);
          }
        } else {
          node.status({ fill: "red", shape: "dot", text: "error" });
          node.error("Invalid event to monitor: " + node.eventType);
        }
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-receiveevent", ReceiveEvent);

  //-----------------------------------------------------------------------------
  //Send generic package node
  function SendPacket(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Initial status
    node.status({ fill: "grey", shape: "dot", text: "inactive" });

    //Check if the device is configured
    if (device) {
      // Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        // Send the message
        node.on("input", function (msg) {
          if (typeof msg.payload === "undefined" || msg.payload === null)
            msg.payload = "msg.payload not set"; //Educational
          if (typeof msg.byteData === "undefined" || msg.byteData === null)
            msg.byteData = new TextEncoder().encode(msg.payload); // If msg.byteData is not defined, msg.paylod will be converted to Uint8Array and used
          if (
            typeof msg.destination === "undefined" ||
            msg.destination === null
          )
            msg.destination = "broadcast";
          if (typeof msg.portNum === "undefined" || msg.portNum === null)
            msg.portNum = 1;
          if (
            typeof msg.wantResponse === "undefined" ||
            msg.wantResponse === null
          )
            msg.wantResponse = false; //This response is crashing the script...
          try {
            connection
              ?.sendPacket(
                msg.byteData,
                msg.portNum,
                msg.destination,
                msg.channel,
                msg.wantAck,
                msg.wantResponse,
                msg.echoResponse,
                msg.replyId,
                msg.emoji
              )
              .then((id) => {
                node.status({ fill: "green", shape: "dot", text: "active" });
                node.trace("Packet sent ID: " + id);
              })
              .catch((e) => {
                node.status({ fill: "red", shape: "dot", text: "error" });
                node.error("Failed to send packet");
                node.error(e);
              });
          } catch (e) {
            node.status({ fill: "red", shape: "dot", text: "error" });
            node.error("Exception sending packet");
            node.error(e);
          }
        });
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-sendpacket", SendPacket);

  //-----------------------------------------------------------------------------
  //Receive Meshtastic.js log messages node
  function ReceiveLog(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Initial status
    node.status({ fill: "grey", shape: "dot", text: "inactive" });

    //Check if the device is configured
    if (device) {
      // Meshtastic node is active
      connectionReady.once(device.eventReady, (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        try {
          connection.log.attachTransport((data) => {
            node.status({ fill: "green", shape: "dot", text: "active" });
            data.payload = data[0] + ": " + data[1];
            node.send(data);
          });
        } catch (e) {
          node.status({ fill: "red", shape: "dot", text: "error" });
          node.error("Exception in the log event monitor");
          node.error(e);
        }
      });
    }
  }
  RED.nodes.registerType("meshtastic-msg-log", ReceiveLog);

  //-----------------------------------------------------------------------------
  //Meshtastic device configuration node
  function DeviceNode(config) {
    RED.nodes.createNode(this, config);
    let node = this;

    //Unique identifier for the physical device
    node.identifier = Math.random().toString(16).slice(2);
    node.eventReady = "ready-" + node.identifier; //Event for connection ready

    //Connection parameters and failsafe defaults (to prevent crashes after updates)
    let address =
      config.address === undefined ? "meshtastic.local" : config.address;
    let fetchInterval =
      Number(config.fetch_interval) == 0 ? 5000 : Number(config.fetch_interval);
    let logLevel = Number(config.log_level);
    let connectionMode =
      config.connection_mode === undefined ? "http" : config.connection_mode;
    let tls = connectionMode == "https" ? true : false;

    //Initate a connection
    this.trace("Connection mode >> " + connectionMode);
    if (connectionMode == "serial") {
      TransportSerial.create(address).then(
        (transport) => {
          transport.fetchInterval = fetchInterval;
          node.connection = new MeshDevice(transport);
          node.connection.log.settings.minLevel = logLevel;
          connectionReady.emit(node.eventReady, node.connection);
          node.trace("Device connected by serial port: " + address);
        },
        (e) => {
          node.error("Exception in the serial connection");
          node.error(e);
        }
      );
    } else {
      TransportHTTP.create(address, tls).then(
        (transport) => {
          transport.fetchInterval = fetchInterval;
          node.connection = new MeshDevice(transport);
          node.connection.log.settings.minLevel = logLevel;
          connectionReady.emit(node.eventReady, node.connection);
          node.trace("Device connected by http/https: " + address);
        },
        (e) => {
          node.error("Exception in the http/https connection");
          node.error(e);
        }
      );
    }

    // Execute when the device is ready
    connectionReady.once(node.eventReady, (connection) => {
      //Add your code here
    });

    //Disconnect when done
    node.on("close", function (done) {
      node.trace("Device disconnected: " + address);
      node.connection.disconnect();
      done();
    });
  }
  RED.nodes.registerType("meshtastic-msg-device", DeviceNode);
};
