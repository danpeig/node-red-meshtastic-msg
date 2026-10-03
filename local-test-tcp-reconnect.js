// Regression test for the tcp-mode reconnect/backoff logic in
// meshtastic-msg.js. Does not touch real hardware: runs a bare TCP server
// that accepts a connection (enough to satisfy TransportNode.create(),
// which resolves on the socket's "ready" event, before any Meshtastic
// protocol handshake), kills it after a few seconds to simulate a real
// disconnect, then accepts a second connection to verify the device node
// reconnects on its own and stabilizes.
//
// Run with: node local-test-tcp-reconnect.js

const net = require("node:net");

const PORT = 14403;
let acceptCount = 0;

const server = net.createServer((socket) => {
  acceptCount++;
  console.log(`[server] accepted connection #${acceptCount}`);
  if (acceptCount === 1) {
    setTimeout(() => {
      console.log("[server] killing connection #1 to simulate a disconnect");
      socket.destroy();
    }, 4000);
  } else {
    console.log("[server] keeping connection #2 alive (recovery check)");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] listening on 127.0.0.1:${PORT}`);
  runHarness();
});

function runHarness() {
  const registeredTypes = {};
  const RED = {
    nodes: {
      registerType(name, Constructor) {
        registeredTypes[name] = Constructor;
      },
      createNode(instance, config) {
        instance.status = (s) => console.log("[status]", instance._label || "", s);
        instance.trace = (m) => console.log("[trace]", instance._label || "", m);
        instance.warn = (m) => console.log("[warn]", instance._label || "", m);
        instance.error = (m) => console.log("[error]", instance._label || "", m);
        instance.on = (event, handler) => {
          instance._handlers = instance._handlers || {};
          instance._handlers[event] = handler;
        };
      },
      getNode() {
        return deviceNodeInstance;
      },
    },
  };

  require("./meshtastic-msg.js")(RED);

  const DeviceNode = registeredTypes["meshtastic-msg-device"];
  var deviceNodeInstance = Object.create(DeviceNode.prototype);
  deviceNodeInstance._label = "device";
  DeviceNode.call(deviceNodeInstance, {
    address: `127.0.0.1:${PORT}`,
    connection_mode: "tcp",
    fetch_interval: 5000,
    log_level: 3,
  });

  // Exit codes: 0 = recovered, 1 = never reconnected within the window.
  setTimeout(() => {
    if (acceptCount >= 2) {
      console.log("PASS: reconnected after the forced disconnect");
      process.exit(0);
    } else {
      console.log("FAIL: did not reconnect within the test window");
      process.exit(1);
    }
  }, 15000);
}
