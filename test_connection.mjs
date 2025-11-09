/*
------------------------------------------------------------------------------
This tests the connectivity to the device using HTTP or HTTPs protocol.
For troubleshooting puroposes only.

Note: Requires nodejs installed (test running `node` command)

1. Modify the configuration below
2. Run with the command `node test_connection.mjs`

------------------------------------------------------------------------------
*/

//Configuration
let tls = false //If using TLS (true or false)
let address = "meshtastic.local" //IP address or host name

//Below is the exact connection protocol used my Meshtastic Web HTTP transport protocol
const connectionUrl = `${tls ? "https" : "http"}://${address}`;
let response = await fetch(`${connectionUrl}/api/v1/toradio`, {
    method: "OPTIONS",
})
console.log(response)

/*

------------------------------------------------------------------------------
If everything is OK, you should see a response like below:

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
In case of problems, you should expect something like this
EHOSTUNREACH in the example below means the device cannot be reached from the current server (DNS, firewall, NAT, etc...)

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
    address: 'wrong.device.ip',
    port: 80
}}

*/
