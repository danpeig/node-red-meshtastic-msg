const importSync = require("import-sync"); //Synchronous module loader
const meshtasticjs = importSync("../../@meshtastic/js/dist/index.js"); //This is required because Node-RED does not support ES Modules
const HttpConnection = meshtasticjs.HttpConnection;

module.exports = function (RED) {
  //-----------------------------------------------------------------------------
  //Send text messages node
  function SendText(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Retrieve the Meshtastic device node
    let device = RED.nodes.getNode(config.device);

    //Check if the device is configured
    if (device) {
      // Send the message
      node.on("input", function (msg) {
        if (typeof msg.payload === "undefined" || msg.payload === null) msg.payload = "msg.payload not set"; //Educational
        try {
          device.connection
            ?.sendText(msg.payload, msg.destination, msg.wantAck, msg.channel)
            .then((id) => {
              console.log("Message sent. ID: " + id);
            })
            .catch((e) => {
              console.log("Failed to send message. Error: " + e);
            });
        } catch (e) {
          console.log("Exception in the text message sender. Error: " + e);
        }
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

    //Check if the device is configured
    if (device) {
      try {
        device.connection.events.onMessagePacket.subscribe(function (data) {
          //Execute when a message was received
          data.payload = data.data; //Copy the text to the payload field
          node.send(data);
        });
      } catch (e) {
        console.log("Exception in the message receive listener. Error: " + e);
      }
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

    //Check if the device is configured
    if (device) {
      try {
        device.connection.events.onDeviceStatus.subscribe(function (data) {
          //Execute when a message was received
          //Nice visualization of the status
          switch (data) {
            case 1:
              node.status({ fill: "red", shape: "dot", text: "restarting" });
              break;
            case 3:
              node.status({ fill: "yellow", shape: "dot", text: "connecting" });
              break;
            case 4:
              node.status({ fill: "yellow", shape: "dot", text: "reconnecting" });
              break;
            case 5:
              node.status({ fill: "green", shape: "dot", text: "connected" });
              break;
            case 6:
              node.status({ fill: "blue", shape: "dot", text: "configuring" });
              break;
            case 7:
              node.status({ fill: "green", shape: "dot", text: "configured" });
              break;
            default:
              node.status({ fill: "grey", shape: "dot", text: "unknown" });
          }
          let output = {};
          output.payload = data;
          node.send(output);
        });
      } catch (e) {
        console.log("Exception in the status listener. Error: " + e);
      }
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

    //Check if the device is configured
    if (device) {
      if (device.connection.events[node.eventType] !== undefined) {
        console.log("Setup an event monitor for: " + node.eventType);
        try {
          device.connection.events[node.eventType].subscribe(function (data) {
            //Forward the data directly to the output
            node.send(data);
          });
        } catch (e) {
          console.log("Exception in the event listener. Error: " + e);
        }
      } else {
        console.log("Failed to setup an event monitor for: " + node.eventType);
      }
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

    //Check if the device is configured
    if (device) {
      // Send the message
      node.on("input", function (msg) {
        if (typeof msg.payload === "undefined" || msg.payload === null) msg.payload = "msg.payload not set"; //Educational
        if (typeof msg.byteData === "undefined" || msg.byteData === null)
          msg.byteData = new TextEncoder().encode(msg.payload); // If msg.byteData is not defined, msg.paylod will be converted to Uint8Array and used
        if (typeof msg.destination === "undefined" || msg.destination === null) msg.destination = "broadcast";
        if (typeof msg.portNum === "undefined" || msg.portNum === null) msg.portNum = 1;
        if (typeof msg.wantResponse === "undefined" || msg.wantResponse === null) msg.wantResponse = false; //This response is crashing the script...
        try {
          device.connection
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
              console.log("Packet sent. ID: " + id);
            })
            .catch((e) => {
              console.log("Failed to send packet. Error: " + e);
            });
        } catch (e) {
          console.log("Exception sending packet. Error: " + e);
        }
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

    //Check if the device is configured
    if (device) {
      try {
        device.connection.log.attachTransport((data) => {
			data.payload = data[0] + ": " + data[1];
            node.send(data);
            });
      } catch (e) {
        console.log("Exception in the log event monitor. Error: " + e);
      }
    }
  }
  RED.nodes.registerType("meshtastic-msg-log", ReceiveLog);

  //-----------------------------------------------------------------------------
  //Meshtastic device configuration node
  function DeviceNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    //Connection parameters with safeguards
    let connection_settings = {
      address: config.ip_address,
      fetchInterval: Number(config.fetch_interval),
      tls: config.tls == "false" ? false : true,
    };

    //Initate a connection
    const id = Math.floor(Math.random() * 1e9);
    node.connection = new HttpConnection(id);

    // Log fine tuning. I still don't see a reason for having this exposed in the graphical interface.
    // Log levels:
    //0: silly, 1: trace, 2: debug, 3: info, 4: warn, 5: error, 6: fatal
    //node.connection.log.settings.minLevel = 7;

    try {
      node.connection.connect(connection_settings);
    } catch (e) {
      console.log("Exception in the connection. Error: " + e);
    }

    //Disconnect when done
    node.on("close", function (done) {
      node.connection.disconnect();
      done();
    });
  }
  RED.nodes.registerType("meshtastic-msg-device", DeviceNode);
};
