const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';

// MQTT Configuration
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

// ======= WEBSOCKET CONNECTION =======
let ws = null;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected to RVM');
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('📩 RVM Event:', message);
      
      // Publish RVM events to MQTT
      const eventTopic = `rvm/${DEVICE_ID}/events`;
      mqttClient.publish(eventTopic, JSON.stringify({
        deviceId: DEVICE_ID,
        function: message.function,
        data: message.data,
        timestamp: new Date().toISOString()
      }));
      
      // Log specific events
      if (message.function === 'aiPhoto') {
        console.log('🤖 AI Detection:', message.data);
      } else if (message.function === 'deviceStatus') {
        console.log('📦 Bin Status:', message.data);
      } else if (message.function === '03') {
        console.log('⚠️ Device Error:', message.data);
      }
      
    } catch (err) {
      console.error('❌ WebSocket parse error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

// ======= MQTT CLIENT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker');
  
  // Subscribe to commands for this device
  const commandTopic = `rvm/${DEVICE_ID}/commands`;
  mqttClient.subscribe(commandTopic, (err) => {
    if (!err) {
      console.log(`📡 Subscribed to: ${commandTopic}`);
    } else {
      console.error('❌ Subscribe error:', err.message);
    }
  });
  
  // Start WebSocket connection
  connectWebSocket();
});

// ======= HANDLE COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log(`📩 Command received: ${message.toString()}`);
  
  try {
    const command = JSON.parse(message.toString());
    let result;
    
    if (command.action === 'openGate') {
      // Call local RVM API to open gate
      result = await axios.post(`${LOCAL_API_BASE}/system/serial/motorSelect`, {
        moduleId: '05',
        motorId: '01',
        type: '03',
        deviceType: 1
      });
      console.log('✅ Gate opened');
      
    } else if (command.action === 'closeGate') {
      // Call local RVM API to close gate
      result = await axios.post(`${LOCAL_API_BASE}/system/serial/motorSelect`, {
        moduleId: '05',
        motorId: '01',
        type: '00',
        deviceType: 1
      });
      console.log('✅ Gate closed');
      
    } else {
      console.log('⚠️ Unknown command:', command.action);
      return;
    }
    
    // Send response back
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: command.action,
      success: true,
      result: result.data,
      timestamp: new Date().toISOString()
    }));
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    
    // Send error response
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: message.toString(),
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }));
  }
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('🔄 Reconnecting to MQTT...');
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('========================================');
console.log('🚀 RVM Agent Started');
console.log(`📱 Device ID: ${DEVICE_ID}`);
console.log(`🔌 Local API: ${LOCAL_API_BASE}`);
console.log(`💬 WebSocket: ${WS_URL}`);
console.log('========================================');