// Minimal local test harness for the patched tcp connection mode.
// Not a reimplementation: this drives the real meshtastic-msg.js module
// through a tiny mock of the RED node-registration API, exactly the way
// Node-RED itself would, so the test exercises the actual patched code
// path (deviceConnect's new "tcp" branch), not a copy of its logic.

const registeredTypes = {};

const RED = {
  nodes: {
    registerType(name, Constructor) {
      registeredTypes[name] = Constructor;
    },
    createNode(instance, config) {
      instance.status = (s) => console.log("[status]", instance._label || "", s);
      instance.trace = (m) => console.log("[trace]", instance._label || "", m);
      instance.error = (m) => console.log("[error]", instance._label || "", m);
      instance.on = (event, handler) => {
        instance._handlers = instance._handlers || {};
        instance._handlers[event] = handler;
      };
    },
    getNode(id) {
      return deviceNodeInstance;
    },
  },
};

require("./meshtastic-msg.js")(RED);

const args = process.argv.slice(2);
const address = args[0] || "192.168.1.66:4403";
const message = args[1] || "local-test-tcp-mode: patched connection works";

console.log("Connecting via tcp to " + address + " ...");

const DeviceNode = registeredTypes["meshtastic-msg-device"];
let deviceNodeInstance = Object.create(DeviceNode.prototype);
deviceNodeInstance._label = "device";
DeviceNode.call(deviceNodeInstance, {
  address: address,
  connection_mode: "tcp",
  fetch_interval: 5000,
  log_level: 3,
});

const SendText = registeredTypes["meshtastic-msg-send"];
let sendNodeInstance = Object.create(SendText.prototype);
sendNodeInstance._label = "send";
SendText.call(sendNodeInstance, { device: "device-under-test" });

setTimeout(() => {
  if (!sendNodeInstance._handlers || !sendNodeInstance._handlers["input"]) {
    console.error("FAIL: device never reached ready state, no input handler registered");
    process.exit(1);
  }
  console.log("Sending: " + message);
  sendNodeInstance._handlers["input"]({ payload: message });
  setTimeout(() => {
    console.log("Done. Check the listening device for the message.");
    process.exit(0);
  }, 10000);
}, 6000);
