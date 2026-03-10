const net = require("net");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

/* APRS CONFIG */
const APRS_HOST = "rotate.aprs2.net";
const APRS_PORT = 14580;
const APRS_USER = "NOCALL";
const APRS_PASS = "-1";

/* PUERTO RICO BOUNDING BOX */
const MIN_LAT = 17.5;
const MAX_LAT = 18.7;
const MIN_LON = -67.5;
const MAX_LON = -65.0;

let stations = {};
let packets = 0;

function connectAPRS() {

console.log("Conectando a APRS...");

const client = new net.Socket();

client.connect(APRS_PORT, APRS_HOST, () => {

console.log("Conectado a APRS");

client.write(`user ${APRS_USER} pass ${APRS_PASS} vers hurricane-pr 1.0\n`);

});

client.on("data", data => {

const lines = data.toString().split("\n");

lines.forEach(line => {

packets++;

const match = line.match(/(\d{2})(\d{2}\.\d{2})(N|S)\/(\d{3})(\d{2}\.\d{2})(E|W)/);

if(!match) return;

let lat = parseFloat(match[1]) + parseFloat(match[2]) / 60;
let lon = parseFloat(match[4]) + parseFloat(match[5]) / 60;

if(match[3] === "S") lat *= -1;
if(match[6] === "W") lon *= -1;

if(lat > MIN_LAT && lat < MAX_LAT && lon > MIN_LON && lon < MAX_LON){

const callsign = line.split(">")[0];

stations[callsign] = {
callsign,
lat,
lon,
time: Date.now()
};

}

});

});

client.on("close", () => {

console.log("APRS desconectado. Reconectando en 10s...");
setTimeout(connectAPRS,10000);

});

client.on("error", err => {
console.log("Error APRS:",err.message);
});

}

connectAPRS();

/* API */

app.get("/", (req,res)=>{

res.json({
status:"online",
stations:Object.keys(stations).length,
packets
});

});

app.get("/cwop",(req,res)=>{

res.json(Object.values(stations));

});

app.listen(PORT,()=>{

console.log("Server corriendo en puerto",PORT);

});
