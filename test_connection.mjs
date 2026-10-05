/*
------------------------------------------------------------------------------
This tests the connectivity to the device using HTTP, HTTPs or TCP protocol.
For troubleshooting puroposes only.

Note: Requires nodejs installed (test running `node` command)

1. Modify the configuration below
2. Run with the command `node test_connection.mjs`

------------------------------------------------------------------------------
*/

import { Socket } from "node:net";

//Configuration
let mode = "http" //Connection mode to test: "http" or "tcp"
let tls = false //If using TLS (true or false). Only used when mode is "http"
let address = "meshtastic.local" //IP address or host name
let port = 4403 //Meshtastic native TCP API port. Only used when mode is "tcp"

if (mode === "tcp") {
    //Below is the exact connection protocol used by Meshtastic Web's node TCP transport
    const socket = new Socket();
    socket.setTimeout(5000);
    socket.once("ready", () => {
        console.log("Connected to " + address + ":" + port + " (TCP API reachable)");
        socket.destroy();
    });
    socket.once("timeout", () => {
        console.log("Timed out connecting to " + address + ":" + port);
        socket.destroy();
    });
    socket.once("error", (err) => {
        console.log("Failed to connect to " + address + ":" + port);
        console.log(err);
    });
    socket.connect(port, address);
} else {
    //Below is the exact connection protocol used by Meshtastic Web's HTTP transport
    const connectionUrl = `${tls ? "https" : "http"}://${address}`;
    let response = await fetch(`${connectionUrl}/api/v1/toradio`, {
        method: "OPTIONS",
    })
    console.log(response)
}

/*

------------------------------------------------------------------------------
If everything is OK with "http" mode, you should see a response like below:

Response {
  status: 204,
  statusText: 'OK',
  headers: Headers {
    'content-type': 'application/x-protobuf',
    'access-control-allow-headers': 'Content-Type',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'PUT, OPTIONS',
    'x-protobuf-schema': 'https://raw.githubusercontent.com/meshtastic/protobufs/master/meshtastic/mesh.proto',
    connection: 'keep-alive',
    'content-length': '0'
  },
  body: null,
  bodyUsed: false,
  ok: true,
  redirected: false,
  type: 'basic',
  url: 'http://my_device_ip/api/v1/toradio'
}

------------------------------------------------------------------------------
In case of problems with "http" mode, you should expect something like this.
EHOSTUNREACH in the example below means the device cannot be reached from the current server (DNS, firewall, NAT, etc...).

node:internal/deps/undici/undici:14130
      Error.captureStackTrace(err);
            ^

TypeError: fetch failed
    at node:internal/deps/undici/undici:14130:13
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async file:///test_connection.mjs:18:16 {
  [cause]: Error: connect EHOSTUNREACH wrong.device.ip:80
      at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1605:16) {
    errno: -113,
    code: 'EHOSTUNREACH',
    syscall: 'connect',
    address: '192.168.1.200',
    port: 80
}}

------------------------------------------------------------------------------
If "http" mode fails but the device is otherwise known to be online, it is
possible the device's firmware was built without the HTTP API. Official
ESP32 release builds from meshtastic/firmware set MESHTASTIC_EXCLUDE_WEBSERVER=1
and strip the HTTP API out of the compiled binary entirely — the native TCP
API (port 4403) stays available either way. Switch mode to "tcp" above and
re-run to check.

------------------------------------------------------------------------------
If everything is OK with "tcp" mode, you should see:

Connected to my_device_ip:4403 (TCP API reachable)

------------------------------------------------------------------------------
In case of problems with "tcp" mode, you should expect something like this.
ECONNREFUSED means the port isn't open — either the device's firmware has no
TCP API (unlikely, it's built in by default) or the address/port is wrong.

Failed to connect to wrong.device.ip:4403
Error: connect ECONNREFUSED wrong.device.ip:4403
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16) {
  errno: -111,
  code: 'ECONNREFUSED',
  syscall: 'connect',
  address: '192.168.1.200',
  port: 4403
}

*/
