/*

BONUS!
This is a quick boilerplate for meshtastic.js input and output.
It is not used by Node-RED module but could help you to understand how to use the library.

Daniel B.P. (www.danbp.org)
27/07/2024

Please ensure you had downloaded and installed the @meshtastic/js package according to the instructions in their website.

*/

import { HttpConnection } from "@meshtastic/js";

let ip = "192.168.1.65";
let tls = false;
let fetchInterval = 5000;
let message = "Testing! Ai ai ai!";
let destination = 4294967295;
let wantAck = true;
let channel = 1;

//Random connection ID
const randId = () => {
  return Math.floor(Math.random() * 1e9);
};
const id = randId();

// Handle HTTP connection
const connection = new HttpConnection(id);
await connection.connect({
  address: ip,
  fetchInterval: fetchInterval,
  tls: tls,
});

//Read device status
let deviceStatus = 0;
await connection.events.onDeviceStatus.subscribe(
  function(status){
    deviceStatus = status;
  }
)

//Send message
const sendText = async (message, destination, ack, channel) => {
    await connection
      ?.sendText(message, destination, ack, channel)
      .then((id) => {
        console.log("MESSAGE SENT: ");
        console.log(id);
      }
      )
      .catch((e) =>
      {
        console.log("ERROR SENDING MESSAGE: ");
        console.log(e);
      }
      );
};

//Test the send message
sendText(message, destination, wantAck, channel);

// Output received messages
await connection.events.onMessagePacket.subscribe(function(message){
  //Execute when a message was received
	console.log(message);
});

//connection.disconnect();