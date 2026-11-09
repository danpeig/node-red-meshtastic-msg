// Regression test for the "ondemand" connection policy in
// meshtastic-msg.js. Does not touch real hardware: runs a bare TCP server
// on 127.0.0.1 (ephemeral port) and counts the connections it accepts.
// Two MeshDevice methods are replaced by fakes, because a bare TCP server
// never speaks the Meshtastic protocol:
//   sendText()  resolves after a delay set by the payload prefix
//   configure() reports DeviceConfigured at once, unless told to hang
//
// Run with: node local-test-on-demand.js
// Exit codes: 0 = every check passed, 1 = at least one check failed.

const net = require("node:net");
const importSync = require("import-sync");
const meshtasticCore = importSync("@meshtastic/core"); //Same instance as the one meshtastic-msg.js loads
const registerMeshtasticMsg = require("./meshtastic-msg.js");

const DeviceStatusEnum = meshtasticCore.Types.DeviceStatusEnum;
const FAST_SEND_MS = 50;
const SLOW_SEND_MS = 2000;

//Payload prefixes: "slow" takes SLOW_SEND_MS, "throw" throws before it
//returns a Promise, anything else takes FAST_SEND_MS.
let sendCount = 0;
meshtasticCore.MeshDevice.prototype.sendText = function (text) {
  sendCount++;
  let id = sendCount;
  if (String(text).startsWith("throw"))
    throw new Error("fake synchronous throw");
  let delay = String(text).startsWith("slow") ? SLOW_SEND_MS : FAST_SEND_MS;
  return new Promise((resolve) => setTimeout(() => resolve(id), delay));
};

let configureHangs = false;
let configureCount = 0;
meshtasticCore.MeshDevice.prototype.configure = function () {
  configureCount++;
  if (!configureHangs)
    setTimeout(
      () => this.updateDeviceStatus(DeviceStatusEnum.DeviceConfigured),
      20
    );
  return Promise.resolve();
};

let accepted = 0;
const openSockets = new Set();
const server = net.createServer((socket) => {
  accepted++;
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => {});
});
function dropAllSockets() {
  for (const socket of openSockets) socket.destroy();
}

let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Polls until condition() is true or timeoutMs passes. Use it for "becomes
//true" checks. Use a fixed sleep only for "stays true" checks.
async function waitFor(condition, timeoutMs) {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

let failures = 0;
function check(name, condition) {
  console.log((condition ? "PASS: " : "FAIL: ") + name);
  if (!condition) failures++;
}

//A minimal Node-RED runtime: just enough for the device and send nodes.
function makeRed(logs) {
  const registeredTypes = {};
  let currentDevice;
  const RED = {
    nodes: {
      registerType(name, Constructor) {
        registeredTypes[name] = Constructor;
      },
      createNode(instance) {
        instance.status = () => {};
        instance.trace = () => {};
        instance.warn = (m) => logs.push("warn: " + m);
        instance.error = (m) =>
          logs.push("error: " + (m && m.message ? m.message : m));
        instance._handlers = {};
        instance.on = (event, handler) => {
          instance._handlers[event] = handler;
        };
      },
      getNode() {
        return currentDevice;
      },
    },
  };
  registerMeshtasticMsg(RED);
  return {
    makeDevice(config) {
      const DeviceNode = registeredTypes["meshtastic-msg-device"];
      currentDevice = Object.create(DeviceNode.prototype);
      DeviceNode.call(currentDevice, {
        address: "127.0.0.1:" + server.address().port,
        connection_mode: "tcp",
        fetch_interval: 5000,
        log_level: 6,
        ...config,
      });
      return currentDevice;
    },
    makeSender() {
      const SendText = registeredTypes["meshtastic-msg-send"];
      const sender = Object.create(SendText.prototype);
      SendText.call(sender, { device: "x" });
      return (payload) => sender._handlers.input({ payload });
    },
  };
}

function closeDevice(device) {
  return new Promise((resolve) => device._handlers.close(resolve));
}

function count(logs, prefix) {
  return logs.filter((l) => l.startsWith(prefix)).length;
}

function testIdleTimeoutParsing() {
  const red = makeRed([]);
  const cases = [
    [undefined, 30000, "missing uses the default"],
    ["", 30000, "empty uses the default"],
    ["abc", 30000, "not a number uses the default"],
    ["-5", 30000, "negative uses the default"],
    ["10000", 10000, "a valid value is used"],
    ["1e12", 86400000, "a huge value is capped"],
  ];
  for (const [value, expectedMs, name] of cases) {
    const device = red.makeDevice({
      connection_policy: "ondemand",
      idle_timeout: value,
    });
    check("idle timeout: " + name, device.idleTimeoutMs === expectedMs);
    device._handlers.close(() => {});
  }
}

async function testOnDemand() {
  const base = accepted;
  const logs = [];
  const red = makeRed(logs);
  const device = red.makeDevice({
    connection_policy: "ondemand",
    idle_timeout: "1000",
  });
  const send = red.makeSender();

  await sleep(500);
  check("on demand: no connection at start", accepted === base);

  send("one");
  send("two");
  check(
    "on demand: both sends went out",
    await waitFor(() => sendCount === 2, 2000)
  );
  check(
    "on demand: two sends at once open one connection",
    accepted === base + 1
  );
  check(
    "on demand: the open runs the config handshake once",
    configureCount === 1
  );

  await sleep(500);
  check(
    "on demand: connection still open inside the idle time",
    openSockets.size === 1
  );
  check(
    "on demand: connection closed after the idle time",
    await waitFor(() => openSockets.size === 0, 2000)
  );

  //A fast and a slow send overlap. The fast one settles at once. The idle
  //time (1 s) must not run while the slow one (2 s) is in flight.
  send("fast");
  send("slow");
  check(
    "on demand: a send after the close opens a new connection",
    await waitFor(() => accepted === base + 2, 2000)
  );
  await sleep(1500);
  check(
    "on demand: no close while a send is in flight",
    openSockets.size === 1
  );
  check(
    "on demand: closed after the slow send settled plus the idle time",
    await waitFor(() => openSockets.size === 0, 3000)
  );

  //The radio drops an idle connection (another client, or its idle timeout).
  send("three");
  await waitFor(() => openSockets.size === 1, 2000);
  await sleep(200); //"three" has settled, the idle timer runs
  dropAllSockets();
  await sleep(1500);
  check(
    "on demand: a drop while idle does not reconnect",
    accepted === base + 3
  );
  check(
    "on demand: a drop while idle logs no warning",
    count(logs, "warn") === 0
  );

  //The radio drops the connection while a send waits for its ACK.
  let sentBeforeDrop = sendCount;
  send("slow while dropped");
  await waitFor(() => sendCount === sentBeforeDrop + 1, 2000); //Past the config handshake
  check(
    "on demand: a send after a drop opens a new connection",
    accepted === base + 4
  );
  dropAllSockets();
  check(
    "on demand: a drop while a send waits logs one warning",
    await waitFor(
      () => count(logs, "warn: Device disconnected while a send") === 1,
      2000
    )
  );
  await sleep(SLOW_SEND_MS); //Let the slow send settle
  check("on demand: no errors logged", count(logs, "error") === 0);

  send("throw now");
  check(
    "on demand: a send that throws logs Failed to send",
    await waitFor(() => logs.includes("error: Failed to send"), 2000)
  );
  check(
    "on demand: a send that throws leaves no unhandled rejection",
    unhandled === 0
  );

  await closeDevice(device);
  check(
    "on demand: node close closes the connection",
    await waitFor(() => openSockets.size === 0, 2000)
  );
}

async function testOnDemandOpenFails() {
  const logs = [];
  const red = makeRed(logs);
  const device = red.makeDevice({
    connection_policy: "ondemand",
    address: "127.0.0.1:1", //Nothing listens on port 1
  });
  const send = red.makeSender();
  send("nobody listens");
  check(
    "on demand: a failed open logs one error for that send",
    await waitFor(() => count(logs, "error: Cannot send") === 1, 2000)
  );
  await sleep(2000);
  check("on demand: a failed open does not retry", count(logs, "error") === 1);
  await closeDevice(device);
}

async function testOnDemandConfigureTimeout() {
  const base = accepted;
  const sentBefore = sendCount;
  const logs = [];
  const red = makeRed(logs);
  const device = red.makeDevice({ connection_policy: "ondemand" });
  device.configureTimeoutMs = 500;
  const send = red.makeSender();
  configureHangs = true;
  send("never configured");
  check(
    "on demand: a config timeout logs one error",
    await waitFor(
      () => count(logs, "error: Cannot send: radio did not finish") === 1,
      2000
    )
  );
  configureHangs = false;
  check(
    "on demand: a config timeout opened one connection",
    accepted === base + 1
  );
  check("on demand: a config timeout sends nothing", sendCount === sentBefore);
  check(
    "on demand: a config timeout closes the connection",
    await waitFor(() => openSockets.size === 0, 2000)
  );
  await closeDevice(device);
}

async function testOnDemandCloseDuringOpen() {
  const sentBefore = sendCount;
  const logs = [];
  const red = makeRed(logs);
  const device = red.makeDevice({ connection_policy: "ondemand" });
  const send = red.makeSender();
  configureHangs = true; //Hold the open inside the config handshake
  send("closed while opening");
  await waitFor(() => openSockets.size === 1, 2000);
  await closeDevice(device);
  configureHangs = false;
  check(
    "on demand: a close during the open closes the connection",
    await waitFor(() => openSockets.size === 0, 2000)
  );
  await sleep(300);
  check(
    "on demand: a close during the open sends nothing",
    sendCount === sentBefore
  );
  check(
    "on demand: a close during the open leaves no unhandled rejection",
    unhandled === 0
  );
}

async function testPersistent() {
  const base = accepted;
  const logs = [];
  const red = makeRed(logs);
  const device = red.makeDevice({}); //No policy set: must stay persistent
  check(
    "persistent: connects at start",
    await waitFor(() => accepted === base + 1, 2000)
  );
  await sleep(1500);
  check("persistent: stays open with no send", openSockets.size === 1);
  dropAllSockets();
  check(
    "persistent: reconnects after a drop",
    await waitFor(() => accepted === base + 2, 3000)
  );
  check(
    "persistent: the drop logs the reconnect warning",
    logs.includes("warn: Device disconnected, reconnecting")
  );
  await closeDevice(device);
}

server.listen(0, "127.0.0.1", async () => {
  testIdleTimeoutParsing();
  await testOnDemand();
  await testOnDemandOpenFails();
  await testOnDemandConfigureTimeout();
  await testOnDemandCloseDuringOpen();
  await testPersistent();
  console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  process.exit(failures === 0 ? 0 : 1);
});
