// Belt Manual Testing Script
// Test belt movements manually to find correct timings
// Save as: test-belt-manual.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');

// ======= CONFIG =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

let currentModuleId = null;
let ws = null;
let beltPosition = '00';
let beltRunning = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= WEBSOCKET =======
function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.function === '01') {
        currentModuleId = message.moduleId;
        console.log(`✅ Module ID: ${currentModuleId}`);
        console.log('\n📋 Manual belt control ready!\n');
        showMenu();
        return;
      }
      
      // Monitor motor status (belt position)
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          motors.forEach(motor => {
            if (motor.motorType === '02') { // Belt motor
              const oldPos = beltPosition;
              beltPosition = motor.position || '00';
              beltRunning = motor.status === '01';
              
              if (oldPos !== beltPosition) {
                console.log(`📍 Belt Position: ${beltPosition} | Running: ${beltRunning ? 'YES' : 'NO'}`);
              }
            }
          });
        } catch (err) {
          // Ignore parse errors
        }
        return;
      }
      
    } catch (err) {
      console.error('❌ WS error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => console.error('❌ WS error:', err.message));
}

// ======= BELT CONTROL FUNCTIONS =======
async function beltForward(durationMs) {
  console.log(`\n➡️ BELT FORWARD for ${durationMs}ms...`);
  
  // Start belt forward
  await executeCommand({
    motorId: '02',
    type: '02' // Forward
  });
  
  const startTime = Date.now();
  let startPos = beltPosition;
  
  // Monitor position
  while (Date.now() - startTime < durationMs) {
    await delay(500);
    console.log(`   Position: ${beltPosition} | Elapsed: ${Date.now() - startTime}ms`);
  }
  
  // Stop belt
  await executeCommand({
    motorId: '02',
    type: '00' // Stop
  });
  
  console.log(`✅ Forward complete: ${startPos} → ${beltPosition} (${Date.now() - startTime}ms)`);
  showMenu();
}

async function beltReverse(durationMs) {
  console.log(`\n⬅️ BELT REVERSE for ${durationMs}ms...`);
  
  // Start belt reverse
  await executeCommand({
    motorId: '02',
    type: '01' // Reverse
  });
  
  const startTime = Date.now();
  let startPos = beltPosition;
  
  // Monitor position
  while (Date.now() - startTime < durationMs) {
    await delay(500);
    console.log(`   Position: ${beltPosition} | Elapsed: ${Date.now() - startTime}ms`);
  }
  
  // Stop belt
  await executeCommand({
    motorId: '02',
    type: '00' // Stop
  });
  
  console.log(`✅ Reverse complete: ${startPos} → ${beltPosition} (${Date.now() - startTime}ms)`);
  showMenu();
}

async function beltStop() {
  console.log('\n🛑 STOPPING BELT...');
  
  await executeCommand({
    motorId: '02',
    type: '00' // Stop
  });
  
  console.log('✅ Belt stopped');
  console.log(`📍 Final Position: ${beltPosition}`);
  showMenu();
}

async function beltForwardUntilLimit() {
  console.log('\n➡️ BELT FORWARD until limit switch...');
  
  // Start belt forward
  await executeCommand({
    motorId: '02',
    type: '02' // Forward
  });
  
  const startTime = Date.now();
  let startPos = beltPosition;
  let lastPos = beltPosition;
  
  // Monitor until position 03 (end limit) or timeout
  while (Date.now() - startTime < 15000) {
    await delay(500);
    
    if (beltPosition !== lastPos) {
      console.log(`   Position: ${beltPosition} | Elapsed: ${Date.now() - startTime}ms`);
      lastPos = beltPosition;
    }
    
    if (beltPosition === '03') {
      console.log('✅ Reached END limit (position 03)');
      break;
    }
  }
  
  // Stop belt
  await executeCommand({
    motorId: '02',
    type: '00' // Stop
  });
  
  console.log(`✅ Forward complete: ${startPos} → ${beltPosition} (${Date.now() - startTime}ms)`);
  showMenu();
}

async function beltReverseUntilLimit() {
  console.log('\n⬅️ BELT REVERSE until limit switch...');
  
  // Start belt reverse
  await executeCommand({
    motorId: '02',
    type: '01' // Reverse
  });
  
  const startTime = Date.now();
  let startPos = beltPosition;
  let lastPos = beltPosition;
  
  // Monitor until position 00 (start limit) or timeout
  while (Date.now() - startTime < 15000) {
    await delay(500);
    
    if (beltPosition !== lastPos) {
      console.log(`   Position: ${beltPosition} | Elapsed: ${Date.now() - startTime}ms`);
      lastPos = beltPosition;
    }
    
    if (beltPosition === '00') {
      console.log('✅ Reached START limit (position 00)');
      break;
    }
  }
  
  // Stop belt
  await executeCommand({
    motorId: '02',
    type: '00' // Stop
  });
  
  console.log(`✅ Reverse complete: ${startPos} → ${beltPosition} (${Date.now() - startTime}ms)`);
  showMenu();
}

// ======= EXECUTE COMMAND =======
async function executeCommand(params) {
  if (!currentModuleId) {
    console.error('❌ No moduleId');
    return;
  }
  
  const apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
  const apiPayload = {
    moduleId: currentModuleId,
    motorId: params.motorId,
    type: params.type,
    deviceType: 1
  };
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error(`❌ Command failed:`, err.message);
  }
}

async function requestModuleId() {
  try {
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
  }
}

// ======= MENU =======
function showMenu() {
  console.log('\n========================================');
  console.log('🎛️  MANUAL BELT CONTROL');
  console.log('========================================');
  console.log(`📍 Current Position: ${beltPosition}`);
  console.log(`⚙️  Belt Status: ${beltRunning ? 'RUNNING' : 'STOPPED'}`);
  console.log('========================================');
  console.log('1️⃣  Forward 2 sec   (short move)');
  console.log('2️⃣  Forward 4 sec   (medium move)');
  console.log('3️⃣  Forward 6 sec   (long move)');
  console.log('4️⃣  Forward 8 sec   (extra long)');
  console.log('5️⃣  Forward to END  (until limit)');
  console.log('---');
  console.log('6️⃣  Reverse 4 sec   (medium return)');
  console.log('7️⃣  Reverse 8 sec   (full return)');
  console.log('8️⃣  Reverse to START (until limit)');
  console.log('---');
  console.log('9️⃣  STOP belt');
  console.log('0️⃣  Exit');
  console.log('========================================');
  console.log('Position codes: 00=START | 01=MIDDLE | 02=WEIGHING | 03=END/SORTER');
  console.log('========================================\n');
}

// ======= USER INPUT =======
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', async (input) => {
  const choice = input.trim();
  
  switch (choice) {
    case '1':
      await beltForward(2000);
      break;
    case '2':
      await beltForward(4000);
      break;
    case '3':
      await beltForward(6000);
      break;
    case '4':
      await beltForward(8000);
      break;
    case '5':
      await beltForwardUntilLimit();
      break;
    case '6':
      await beltReverse(4000);
      break;
    case '7':
      await beltReverse(8000);
      break;
    case '8':
      await beltReverseUntilLimit();
      break;
    case '9':
      await beltStop();
      break;
    case '0':
      console.log('\n👋 Exiting...');
      process.exit(0);
      break;
    default:
      console.log('⚠️ Invalid choice. Please enter 0-9');
      showMenu();
  }
});

// ======= MQTT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  rl.close();
  process.exit(0);
});

console.log('========================================');
console.log('🧪 BELT MANUAL TEST TOOL');
console.log('========================================');
console.log('Connecting to RVM system...');
console.log('========================================\n');