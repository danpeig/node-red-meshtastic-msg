const importSync = require("import-sync"); //Synchronous module loader
const EventEmitter = require("node:events"); //Manage events
const meshtastic_core = importSync("@meshtastic/core"); //This is required because Node-RED does not support ES Modules
const meshtastic_http = importSync("@meshtastic/transport-http"); //This is required because Node-RED does not support ES Modules
const meshtastic_serial = importSync("@meshtastic/transport-node-serial"); //This is required because Node-RED does not support ES Modules
const meshtastic_tcp = importSync("@meshtastic/transport-node"); //This is required because Node-RED does not support ES Modules
const MeshDevice = meshtastic_core.MeshDevice;
const DeviceStatusEnum = meshtastic_core.Types.DeviceStatusEnum;
const RoutingError = meshtastic_core.Protobuf.Mesh.Routing_Error;
const NEWER_ROUTING_ERRORS = {
  38: "RATE_LIMIT_EXCEEDED",
  39: "PKI_SEND_FAIL_PUBLIC_KEY",
}; //Firmware 2.7 codes missing from @meshtastic/core 2.6.7
const TransportHTTP = meshtastic_http.TransportHTTP;
const TransportSerial = meshtastic_serial.TransportNodeSerial;
const TransportNode = meshtastic_tcp.TransportNode;

const connectionReady = new EventEmitter(); //Notify all nodes of a successful connection
const DEFAULT_IDLE_TIMEOUT_MS = 30000; //"ondemand" policy: close after this long with no send
const MAX_IDLE_TIMEOUT_MS = 86400000; //One day. Keeps the idle timer far below setTimeout's 2^31-1 ms limit
const CONFIGURE_TIMEOUT_MS = 20000; //"ondemand" policy: give up on the config handshake after this long
const SEND_SPACING_MS = 2500; //"ondemand" policy: the firmware rejects a text within 2 s of the previous one (RATE_LIMIT_EXCEEDED)
let systemCrash = false; //Prevents nodes from working in case something goes seriously wrong
const activeDeviceNodes = new Set(); //Every live DeviceNode, so the single global crash handler below can reach all of them

//Emergency catch: prevents other flows and Node-RED from crashing.
//Serial connection, you are responsible for this!
//Registered exactly once at module load, regardless of how many device
//nodes exist -- previously this was registered inside DeviceNode's
//constructor, so N configured devices meant N duplicate global listeners,
//each independently killing every Meshtastic node on the first unhandled
//rejection anywhere in the whole Node-RED instance (not just this module).
process.on("unhandledRejection", (reason, p) => {
  console.log("Unhandled rejection at: ", p, "reason:", reason);
  systemCrash = true; //Activates kills all nodes: everything will stops working
  for (const node of activeDeviceNodes) {
    node.error("Unhandled exception");
    node.error(reason);
    connectionReady.emit(node.eventCrash);
  }
});

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
      if (!device) {
        node.status({ fill: "red", shape: "dot", text: "not connected" });
        node.error("Cannot send: device is not connected");
        return;
      }
      function sent(id) {
        node.status({ fill: "green", shape: "dot", text: "active" });
        node.trace("Sent, id: " + id);
      }
      function sendFailed(e) {
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.error("Failed to send");
        node.error(errorText(e));
      }
      function noConnection(e) {
        node.status({ fill: "red", shape: "dot", text: "not connected" });
        node.error("Cannot send: " + errorText(e));
      }
      sendStarted(device);
      acquireConnection(device)
        .then(
          (connection) =>
            paced(device, () => send(connection, msg)).then(sent, sendFailed),
          noConnection
        )
        .catch(sendFailed) //Last resort: an unhandled rejection kills every node
        .finally(() => sendSettled(device));
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

    //Connection policy. "persistent" (default) holds one connection for the
    //node's whole lifetime and reconnects on every drop. "ondemand"
    //(onDemand) opens a connection only when a send needs one, and closes it
    //after idleTimeoutMs with no send in flight. A radio serves one API client
    //at a time, so a persistent connection keeps every other client (the
    //phone app, the CLI) off the radio. Firmware 2.7 also closes a TCP
    //session that sends nothing for 15 minutes (TCP_IDLE_TIMEOUT_MS). Both
    //are TCP API rules, and reopening a serial port can reset an ESP32
    //board, so "ondemand" is for tcp only. Any other mode stays persistent.
    node.onDemand =
      config.connection_policy === "ondemand" && node.connectionMode === "tcp";
    if (config.connection_policy === "ondemand" && !node.onDemand)
      node.warn(
        "Connection policy ondemand needs tcp mode, using persistent for " +
          node.connectionMode
      );
    node.idleTimeoutMs = Math.min(
      Number(config.idle_timeout) > 0
        ? Number(config.idle_timeout)
        : DEFAULT_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS
    );
    node.inFlight = 0; //Sends started and not yet settled
    node.configureTimeoutMs = CONFIGURE_TIMEOUT_MS; //"ondemand": wait this long for the config handshake
    node.sendSpacingMs = SEND_SPACING_MS;
    node.sendQueue = Promise.resolve(); //See paced()
    node.lastSendAt = 0;

    //Tracked so the single module-level unhandledRejection handler above
    //can reach this node, and untracked on close so it doesn't leak.
    activeDeviceNodes.add(node);

    //Connect. An "ondemand" device waits for its first send.
    if (!node.onDemand) deviceConnect(node);

    //Disconnect when done
    node.on("close", function (done) {
      node.closing = true; //Stop any in-flight or future reconnect attempts
      clearTimeout(node.reconnectTimer);
      clearTimeout(node.idleTimer);
      activeDeviceNodes.delete(node);
      node.trace("Device disconnected: " + node.address);
      let connection = node.connection;
      node.connection = undefined;
      if (connection) closeConnection(node, connection);
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

  //Wraps an open transport in a MeshDevice and makes it the device's
  //current connection. Calls onDrop when this specific connection reports
  //itself disconnected while it is still the current one. The identity
  //check matters because this subscription is never explicitly torn down:
  //without it, a straggler event from an already-superseded connection
  //could clobber a newer, healthy one.
  function adoptConnection(confignode, transport, onDrop) {
    let thisConnection = new MeshDevice(transport);
    confignode.connection = thisConnection;
    thisConnection.log.settings.minLevel = confignode.logLevel;
    connectionReady.emit(confignode.eventReady, thisConnection);

    thisConnection.events.onDeviceStatus.subscribe((status) => {
      if (
        status === DeviceStatusEnum.DeviceDisconnected &&
        !confignode.closing &&
        confignode.connection === thisConnection
      ) {
        confignode.connection = undefined;
        onDrop();
      }
    });
    return thisConnection;
  }

  //Closes a connection or a bare transport that is no longer the current
  //one. Both have an async disconnect(). Never leaves a rejected Promise
  //behind: an unhandled rejection here would trip the module-wide crash
  //handler and kill every Meshtastic node.
  function closeConnection(confignode, connection) {
    connection.disconnect().catch((e) => {
      confignode.trace("Disconnect failed: " + errorText(e));
    });
  }

  //A rejection reason is not always an Error: the library rejects a send
  //that the radio reports as failed with a plain { id, error } object,
  //where error is a Routing_Error number, for example 5 = MAX_RETRANSMIT.
  function errorText(e) {
    if (e instanceof Error) return e.message;
    if (e && typeof e.error === "number")
      return (
        (RoutingError[e.error] ||
          NEWER_ROUTING_ERRORS[e.error] ||
          "routing error " + e.error) +
        " (packet " +
        e.id +
        ")"
      );
    return JSON.stringify(e);
  }

  //Handles the persistent connection lifecycle: connect, watch for
  //disconnects, and retry with backoff. Runs until confignode.closing is set
  //(node removed or redeployed) or a system crash is flagged.
  function deviceConnect(confignode, attempt) {
    attempt = attempt || 0;
    if (confignode.closing) return;
    confignode.trace("Connection mode >> " + confignode.connectionMode);
    try {
      if (systemCrash) throw new Error("Node killed due system crash");
      openTransport(confignode).then(
        (transport) => {
          if (confignode.closing) return; //Node was removed while connecting
          //Watchdog: the moment this connection drops, start reconnecting --
          //instead of leaving every node silently stuck on a dead transport.
          adoptConnection(confignode, transport, () => {
            confignode.warn("Device disconnected, reconnecting");
            scheduleReconnect(confignode, 0); //A connection was established, so restart backoff from scratch
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

  //Returns a Promise of a connection that a send can use. A persistent
  //device only hands out its current connection. An "ondemand" device
  //opens one if it has none. Two sends at the same time share one open
  //attempt. A failed open rejects that send only: there is no retry loop,
  //the next send simply tries again.
  function acquireConnection(confignode) {
    if (systemCrash)
      return Promise.reject(new Error("Node killed due system crash"));
    if (confignode.opening) return confignode.opening; //An open is in progress: share it
    if (confignode.connection) return Promise.resolve(confignode.connection);
    if (!confignode.onDemand)
      return Promise.reject(new Error("device is not connected"));
    if (confignode.closing)
      return Promise.reject(new Error("device node is closing"));
    confignode.trace("Opening an ondemand connection");
    confignode.opening = openTransport(confignode)
      .then((transport) => {
        if (confignode.closing) {
          closeConnection(confignode, transport);
          throw new Error("device node is closing");
        }
        let connection = adoptConnection(confignode, transport, () => {
          //The radio closed it (another client took over, or idle
          //timeout). Normal for this policy, unless a send was waiting.
          if (confignode.inFlight > 0)
            confignode.warn("Device disconnected while a send was waiting");
          else confignode.trace("Device disconnected");
        });
        return configureConnection(confignode, connection).catch((e) => {
          if (confignode.connection === connection)
            confignode.connection = undefined;
          closeConnection(confignode, connection);
          throw e;
        });
      })
      .finally(() => {
        confignode.opening = undefined;
      });
    return confignode.opening;
  }

  //Runs the config handshake and resolves once the radio reports it done.
  //Until a client asks for config, the firmware sends it nothing at all
  //(PhoneAPI state STATE_SEND_NOTHING), not even the routing ACK for a sent
  //packet. Without the handshake every send waits for the library's 60 s
  //queue timeout and then fails, although the packet did go out.
  function configureConnection(confignode, connection) {
    return new Promise((resolve, reject) => {
      let timer;
      let unsubscribe = connection.events.onDeviceStatus.subscribe((status) => {
        if (status === DeviceStatusEnum.DeviceConfigured) {
          finish();
          resolve(connection);
        } else if (status === DeviceStatusEnum.DeviceDisconnected) {
          finish();
          reject(new Error("device disconnected during config"));
        }
      });
      timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            "radio did not finish its config within " +
              confignode.configureTimeoutMs +
              "ms"
          )
        );
      }, confignode.configureTimeoutMs);
      function finish() {
        clearTimeout(timer);
        unsubscribe();
      }
      //configure() resolves on its own queue timeout, not on completion,
      //so completion is read from the status event above.
      connection.configure().catch(() => {});
    });
  }

  //"ondemand" only: runs task() no sooner than sendSpacingMs after the
  //previous send started, in arrival order. Sends that waited for an open
  //are released together, and the firmware drops a text that comes within
  //2 s of the previous one (PhoneAPI::handleToRadioPacket,
  //RATE_LIMIT_EXCEEDED). The queue advances when a send starts, not when
  //its ACK arrives, so a slow ACK does not hold up the next send. sendQueue
  //never rejects. A persistent device sends at once, as before.
  function paced(confignode, task) {
    if (!confignode.onDemand) return Promise.resolve().then(task);
    let start = confignode.sendQueue
      .then(() => {
        let wait =
          confignode.lastSendAt + confignode.sendSpacingMs - Date.now();
        if (wait > 0)
          return new Promise((resolve) => setTimeout(resolve, wait));
      })
      .then(() => {
        confignode.lastSendAt = Date.now();
      });
    confignode.sendQueue = start;
    return start.then(task);
  }

  //Bookkeeping around every send, so an "ondemand" device knows when it
  //is idle. The idle timer starts only when nothing is in flight.
  function sendStarted(confignode) {
    confignode.inFlight++;
    clearTimeout(confignode.idleTimer);
  }

  function sendSettled(confignode) {
    confignode.inFlight--;
    if (!confignode.onDemand) return;
    if (confignode.inFlight > 0) return;
    clearTimeout(confignode.idleTimer);
    confignode.idleTimer = setTimeout(
      () => closeIdle(confignode),
      confignode.idleTimeoutMs
    );
  }

  //Runs only with nothing in flight: sendStarted() clears the timer.
  function closeIdle(confignode) {
    let connection = confignode.connection;
    if (!connection) return;
    confignode.connection = undefined; //Before disconnect, so the drop is not reported
    confignode.trace(
      "No send for " + confignode.idleTimeoutMs + "ms, closing the connection"
    );
    closeConnection(confignode, connection);
  }
};
