const importSync = require("import-sync"); //Synchronous module loader
const EventEmitter = require("node:events"); //Manage events
const meshtastic_core = importSync("@meshtastic/core"); //This is required because Node-RED does not support ES Modules
const meshtastic_http = importSync("@meshtastic/transport-http"); //This is required because Node-RED does not support ES Modules
const meshtastic_serial = importSync("@meshtastic/transport-node-serial"); //This is required because Node-RED does not support ES Modules
const meshtastic_tcp = importSync("@meshtastic/transport-node"); //This is required because Node-RED does not support ES Modules
const MeshDevice = meshtastic_core.MeshDevice;
const DeviceStatusEnum = meshtastic_core.Types.DeviceStatusEnum;
const TransportHTTP = meshtastic_http.TransportHTTP;
const TransportSerial = meshtastic_serial.TransportNodeSerial;
const TransportNode = meshtastic_tcp.TransportNode;

const connectionReady = new EventEmitter(); //Notify all nodes of a successful connection
let systemCrash = false; //Prevents nodes from working in case something goes seriously wrong

module.exports = function (RED) {
  //-----------------------------------------------------------------------------
  //Shared wiring for every node that consumes a device connection: sets the
  //initial status, guards against a missing device config, re-runs `setup`
  //on every (re)connect (not just the first), and gives every node the same
  //error status/log if `setup` throws, and the same "dead" status on crash.
  function onDeviceReady(node, device, initialStatus, setup) {
    node.status(initialStatus);

    if (!device) {
      node.status({ fill: "red", shape: "dot", text: "no device configured" });
      node.error("No Meshtastic device configured for this node");
      return;
    }

    connectionReady.on(device.eventReady, (connection) => {
      try {
        if (systemCrash) throw new Error("Node killed due system crash");
        setup(connection);
      } catch (e) {
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.error("Failed to initialize: " + e.message);
        node.error(e);
      }
    });

    connectionReady.once(device.eventCrash, () =>
      node.status({ fill: "red", shape: "dot", text: "dead" })
    );
  }

  //Shared wiring for input-driven send nodes (SendText, SendPacket).
  //Registered once, independent of (re)connects: always reads the device's
  //current connection at send time, so a reconnect never leaves this
  //handler bound to a stale, dead connection object. `send` must return
  //the Promise from the actual send call.
  function onSendInput(node, device, send) {
    node.on("input", function (msg) {
      if (!device || !device.connection) {
        node.status({ fill: "red", shape: "dot", text: "not connected" });
        node.error("Cannot send: device is not connected");
        return;
      }
      try {
        if (systemCrash) throw new Error("Node killed due system crash");
        send(device.connection, msg)
          .then((id) => {
            node.status({ fill: "green", shape: "dot", text: "active" });
            node.trace("Sent, id: " + id);
          })
          .catch((e) => {
            node.status({ fill: "red", shape: "dot", text: "error" });
            node.error("Failed to send");
            node.error(e);
          });
      } catch (e) {
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.error("Exception while sending");
        node.error(e);
      }
    });
  }

  //-----------------------------------------------------------------------------
  //Send text messages node
  function SendText(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    let device = RED.nodes.getNode(config.device);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "inactive" },
      () => node.status({ fill: "green", shape: "dot", text: "active" })
    );

    onSendInput(node, device, (connection, msg) => {
      if (typeof msg.payload === "undefined" || msg.payload === null)
        msg.payload = "msg.payload not set"; //Educational
      return connection.sendText(
        msg.payload,
        msg.destination,
        msg.wantAck,
        msg.channel
      );
    });
  }
  RED.nodes.registerType("meshtastic-msg-send", SendText);

  //-----------------------------------------------------------------------------
  //Receive text messages node
  function ReceiveText(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    let device = RED.nodes.getNode(config.device);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "inactive" },
      (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        connection.events.onMessagePacket.subscribe(function (data) {
          data.payload = data.data; //Copy the text to the payload field
          node.trace("Message received >> " + data.data);
          node.status({ fill: "green", shape: "dot", text: "active" });
          node.send(data);
        });
      }
    );
  }
  RED.nodes.registerType("meshtastic-msg-receive", ReceiveText);

  //-----------------------------------------------------------------------------
  //Receive status node
  const STATUS_DISPLAY = {
    1: { fill: "yellow", shape: "ring", text: "restarting" },
    2: { fill: "red", shape: "ring", text: "disconnected" },
    3: { fill: "yellow", shape: "ring", text: "connecting" },
    4: { fill: "yellow", shape: "ring", text: "reconnecting" },
    5: { fill: "green", shape: "dot", text: "connected" },
    6: { fill: "blue", shape: "ring", text: "configuring" },
    7: { fill: "blue", shape: "dot", text: "configured" },
    8: { fill: "red", shape: "dot", text: "error" },
  };
  const STATUS_UNKNOWN = { fill: "grey", shape: "dot", text: "unknown" };

  function DeviceStatus(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    let device = RED.nodes.getNode(config.device);
    let output = { payload: 0, text: "idle" };
    node.send(output);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "offline" },
      (connection) => {
        output.payload = DeviceStatusEnum.DeviceConnected;
        output.text = "connected";
        node.send(output);
        node.status(STATUS_DISPLAY[DeviceStatusEnum.DeviceConnected]);

        connection.events.onDeviceStatus.subscribe(function (data) {
          let display = STATUS_DISPLAY[data] || STATUS_UNKNOWN;
          output.payload = data;
          output.text = display.text;
          node.status(display);
          node.send(output);
        });
      }
    );
  }
  RED.nodes.registerType("meshtastic-msg-status", DeviceStatus);

  //-----------------------------------------------------------------------------
  //Receive generic event
  function ReceiveEvent(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.eventType = config.event;
    let device = RED.nodes.getNode(config.device);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "inactive" },
      (connection) => {
        if (connection.events[node.eventType] === undefined)
          throw new Error("Invalid event to monitor: " + node.eventType);
        node.trace("Initializing event monitor: " + node.eventType);
        node.status({ fill: "green", shape: "dot", text: "active" });
        connection.events[node.eventType].subscribe(function (data) {
          node.status({ fill: "green", shape: "dot", text: "active" });
          node.send(data); //Forward the data directly to the output
        });
      }
    );
  }
  RED.nodes.registerType("meshtastic-msg-receiveevent", ReceiveEvent);

  //-----------------------------------------------------------------------------
  //Send generic package node
  function SendPacket(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    let device = RED.nodes.getNode(config.device);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "inactive" },
      () => node.status({ fill: "green", shape: "dot", text: "active" })
    );

    onSendInput(node, device, (connection, msg) => {
      if (typeof msg.payload === "undefined" || msg.payload === null)
        msg.payload = "msg.payload not set"; //Educational
      if (typeof msg.byteData === "undefined" || msg.byteData === null)
        msg.byteData = new TextEncoder().encode(msg.payload); // If msg.byteData is not defined, msg.paylod will be converted to Uint8Array and used
      if (typeof msg.destination === "undefined" || msg.destination === null)
        msg.destination = "broadcast";
      if (typeof msg.portNum === "undefined" || msg.portNum === null)
        msg.portNum = 1;
      if (typeof msg.wantResponse === "undefined" || msg.wantResponse === null)
        msg.wantResponse = false; //This response is crashing the script...
      return connection.sendPacket(
        msg.byteData,
        msg.portNum,
        msg.destination,
        msg.channel,
        msg.wantAck,
        msg.wantResponse,
        msg.echoResponse,
        msg.replyId,
        msg.emoji
      );
    });
  }
  RED.nodes.registerType("meshtastic-msg-sendpacket", SendPacket);

  //-----------------------------------------------------------------------------
  //Receive Meshtastic.js log messages node
  function ReceiveLog(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    let device = RED.nodes.getNode(config.device);

    onDeviceReady(
      node,
      device,
      { fill: "grey", shape: "dot", text: "inactive" },
      (connection) => {
        node.status({ fill: "green", shape: "dot", text: "active" });
        connection.log.attachTransport((data) => {
          node.status({ fill: "green", shape: "dot", text: "active" });
          data.payload = data[0] + ": " + data[1];
          node.send(data);
        });
      }
    );
  }
  RED.nodes.registerType("meshtastic-msg-log", ReceiveLog);

  //-----------------------------------------------------------------------------
  //Meshtastic device configuration node
  function DeviceNode(config) {
    RED.nodes.createNode(this, config);
    let node = this;

    //Reset the crash status during startup
    systemCrash = false;

    //Unique identifier for the physical device
    node.identifier = Math.random().toString(16).slice(2);
    node.eventReady = "ready-" + node.identifier; //Event for connection ready
    node.eventCrash = "crash-" + node.identifier; //Event for critical error
    node.closing = false; //Set on node removal/redeploy to stop the reconnect loop

    //Connection parameters and failsafe defaults (to prevent crashes after updates)
    node.address =
      config.address === undefined ? "meshtastic.local" : config.address;
    node.fetchInterval =
      Number(config.fetch_interval) == 0 ? 5000 : Number(config.fetch_interval);
    node.logLevel = Number(config.log_level);
    node.connectionMode =
      config.connection_mode === undefined ? "http" : config.connection_mode;
    node.tls = node.connectionMode == "https" ? true : false;

    //Emergency catch: prevents other flows and Node-RED from crashing.
    //Serial connection, you are responsible for this!
    process.on("unhandledRejection", (reason, p) => {
      console.log("Unhandled rejection at: ", p, "reason:", reason);
      node.error("Unhandled exception");
      node.error(reason);
      systemCrash = true; //Activates kills all nodes: everything will stops working
      connectionReady.emit(node.eventCrash);
    });

    //Connect
    deviceConnect(node);

    //Disconnect when done
    node.on("close", function (done) {
      node.closing = true; //Stop any in-flight or future reconnect attempts
      clearTimeout(node.reconnectTimer);
      node.trace("Device disconnected: " + node.address);
      if (node.connection) node.connection.disconnect();
      done();
    });
  }
  RED.nodes.registerType("meshtastic-msg-device", DeviceNode);

  //Splits "host:port" into its parts. Returns the given default port if
  //the address has no ":port" suffix (a bare IPv6 address has no port
  //suffix support here, same limitation as the existing http/serial modes).
  function splitHostPort(address, defaultPort) {
    let separatorIndex = address.lastIndexOf(":");
    if (separatorIndex === -1) return { host: address, port: defaultPort };
    let host = address.slice(0, separatorIndex);
    let port = Number(address.slice(separatorIndex + 1));
    return { host: host, port: port };
  }

  //Reconnect backoff tuning. Retries forever: a mesh device going quiet
  //(reboot, WiFi drop, USB replug) is expected to come back on its own,
  //and silently staying dead forever is worse than retrying occasionally.
  const RECONNECT_BASE_DELAY_MS = 1000;
  const RECONNECT_MAX_DELAY_MS = 30000;

  //Opens the mode-specific transport. Returns a Promise<Transport>.
  //Each branch only does what's specific to that mode -- the shared
  //MeshDevice wrapping, logging and retry logic live in deviceConnect.
  function openTransport(confignode) {
    switch (confignode.connectionMode) {
      case "serial":
        return TransportSerial.create(confignode.address).then((transport) => {
          transport.fetchInterval = confignode.fetchInterval;
          confignode.trace(
            "Device connected by serial port: " + confignode.address
          );
          return transport;
        });
      case "tcp": {
        let hostPort = splitHostPort(confignode.address, 4403);
        // timeout:0 disables node:net's idle-socket timeout. The default
        // (60000ms) tears down a perfectly healthy connection after 60s of
        // mesh silence, which is normal, not a dead link.
        return TransportNode.create(hostPort.host, hostPort.port, 0).then(
          (transport) => {
            confignode.trace(
              "Device connected by tcp: " + hostPort.host + ":" + hostPort.port
            );
            return transport;
          }
        );
      }
      default:
        return TransportHTTP.create(confignode.address, confignode.tls).then(
          (transport) => {
            transport.fetchInterval = confignode.fetchInterval;
            confignode.trace(
              "Device connected by http/https: " + confignode.address
            );
            return transport;
          }
        );
    }
  }

  //Schedules the next connection attempt with capped exponential backoff.
  //attempt=0 means "just lost a working connection, retry almost
  //immediately"; attempt growing means "still failing to connect at all,
  //back off so we don't hammer an unreachable device".
  function scheduleReconnect(confignode, attempt) {
    if (confignode.closing || systemCrash) return;
    let delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
    );
    confignode.trace(
      "Reconnecting in " + delay + "ms (attempt " + (attempt + 1) + ")"
    );
    clearTimeout(confignode.reconnectTimer);
    confignode.reconnectTimer = setTimeout(
      () => deviceConnect(confignode, attempt + 1),
      delay
    );
  }

  //Handles the connection lifecycle: connect, watch for disconnects, and
  //retry with backoff. Runs until confignode.closing is set (node removed
  //or redeployed) or a system crash is flagged.
  function deviceConnect(confignode, attempt) {
    attempt = attempt || 0;
    if (confignode.closing) return;
    confignode.trace("Connection mode >> " + confignode.connectionMode);
    try {
      if (systemCrash) throw new Error("Node killed due system crash");
      openTransport(confignode).then(
        (transport) => {
          if (confignode.closing) return; //Node was removed while connecting
          confignode.connection = new MeshDevice(transport);
          confignode.connection.log.settings.minLevel = confignode.logLevel;
          connectionReady.emit(confignode.eventReady, confignode.connection);

          //Watchdog: the moment this specific connection reports itself
          //disconnected, drop it and start reconnecting -- instead of
          //leaving every node silently stuck on a dead transport forever.
          confignode.connection.events.onDeviceStatus.subscribe((status) => {
            if (
              status === DeviceStatusEnum.DeviceDisconnected &&
              !confignode.closing
            ) {
              confignode.connection = undefined;
              confignode.warn("Device disconnected, reconnecting");
              scheduleReconnect(confignode, 0); //A connection was established, so restart backoff from scratch
            }
          });
        },
        (e) => {
          confignode.error(
            "Exception in the " + confignode.connectionMode + " connection"
          );
          confignode.error(e);
          scheduleReconnect(confignode, attempt); //Never even connected, keep backing off
        }
      );
    } catch (e) {
      confignode.error("Exception in the connection initialization");
      confignode.error(e);
    }
  }
};
