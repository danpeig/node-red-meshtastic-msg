/*

BONUS! QUICK START FOR DEVELOPERS

This is a quick boilerplate for Meshtastic Web javascritp library input and output.
It is not used by Node-RED module but could help you to understand how to use the library.

Daniel B.P. (www.danbp.org)
02/11/2025


How to run:
`
npm install @mesthastic/transport-http
node ./fundamentals_meshtastic_web.mjs
`

*/

// Import the required libraries
// To install the NPM packages, use "npm install @meshtastic/transport-http", the core package will come as a requirement
import { MeshDevice } from "@meshtastic/core";
import { TransportHTTP } from "@meshtastic/transport-http";

//Minimum settings
let ip = "meshtastic.local";
let fetchInterval = 5000;
let tls = false;


const transport = await TransportHTTP.create(ip, tls);
transport.fetchInterval = fetchInterval
const connection = new MeshDevice(transport);

//Read device status
let deviceStatus = 0;
connection.events.onDeviceStatus.subscribe(
  function(status){
    deviceStatus = status;
    console.log(">>>>> STATUS CODE >>>>> "+status)
  }
)

//Send a test message
let message = "Testing! Ai ai ai!";
let destination = 4294967295;
let wantAck = false;
let channel = 0;
const sendText = async (message, destination, wantAck, channel) => {
    await connection
      ?.sendText(message, destination, wantAck, channel)
      .then((id) => {
        console.log(">>>>> MESSAGE SENT >>>>> "+message);
      }
      )
      .catch((e) =>
      {
        console.log(">>>>> ERROR SENDING MESSAGE >>>>> "+e);
      }
      );
};
sendText(message, destination, wantAck, channel);

// Subscribes to an event (onMessagePacket) and prints the received message
connection.events.onMessagePacket.subscribe(function(message){
  //Execute when a message was received
  console.log(">>>>> RECEIVED A MESSAGE >>>>> "+message.data)
});

// Use this to disconnect from the device
//connection.disconnect();