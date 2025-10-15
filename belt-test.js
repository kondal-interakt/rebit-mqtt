// Manual Step-by-Step Control
// Execute each operation manually to debug the issue
// Save as: manual-step-control.js

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
let beltPosition = '??';
let beltStatus = '??';
let drumPosition = '??';

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
        console.log('\n📋 Manual control ready!\n');
        showMenu();
        return;
      }
      
      // Monitor motor status
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          motors.forEach(motor => {
            if (motor.motorType === '02') { // Belt
              const oldPos = beltPosition;
              const oldStatus = beltStatus;
              beltPosition = motor.position || '??';
              beltStatus = motor.status || '??';
              
              if (oldPos !== beltPosition || oldStatus !== beltStatus) {
                console.log(`🔔 BELT UPDATE: Position=${beltPosition} | Status=${beltStatus === '01' ? 'RUNNING' : 'STOPPED'}`);
              }
            }
            if (motor.motorType === '07') { // Drum lift
              drumPosition = motor.position || '??';
            }
          });
        } catch (err) {
          // Ignore
        }
        return;
      }
      
      if (message.function === '06') {
        const weight = parseFloat(message.data) || 0;
        const calibratedWeight = weight * (988 / 1000);
        console.log(`⚖️ WEIGHT: ${calibratedWeight}g (raw: ${weight})`);
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

// ======= MANUAL OPERATIONS =======
async function step1_openGate() {
  console.log('\n🚪 STEP 1: Opening gate...');
  await executeCommand({ moduleId: currentModuleId, motorId: '01', type: '03', deviceType: 1 });
  await delay(1000);
  console.log('✅ Gate opened');
  showMenu();
}

async function step2_beltForward(duration) {
  console.log(`\n➡️ STEP 2: Belt forward for ${duration}ms...`);
  console.log(`📍 Starting position: ${beltPosition}`);
  
  // Start belt
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '02', deviceType: 1 });
  
  const startTime = Date.now();
  while (Date.now() - startTime < duration) {
    await delay(500);
    console.log(`   ${Date.now() - startTime}ms | Position: ${beltPosition} | Status: ${beltStatus}`);
  }
  
  // Stop belt
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 });
  console.log(`✅ Belt stopped at position: ${beltPosition}`);
  showMenu();
}

async function step3_drumUp() {
  console.log('\n🔼 STEP 3: Drum UP...');
  
  // Drum rise
  await executeCommand({ moduleId: '09', motorId: '07', type: '01', deviceType: 5 });
  await delay(3000);
  
  // Drum center
  await executeCommand({ moduleId: '09', motorId: '03', type: '01', deviceType: 5 });
  await delay(2000);
  
  // Stop drum
  await executeCommand({ moduleId: '09', motorId: '03', type: '00', deviceType: 5 });
  
  console.log('✅ Drum raised and centered');
  showMenu();
}

async function step4_getWeight() {
  console.log('\n⚖️ STEP 4: Getting weight...');
  
  const apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
  const apiPayload = { moduleId: currentModuleId, type: '00' };
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('⏳ Waiting for weight result...');
    await delay(3000);
  } catch (err) {
    console.error('❌ Weight request failed:', err.message);
  }
  showMenu();
}

async function step5_drumDown() {
  console.log('\n🔽 STEP 5: Drum DOWN...');
  
  await executeCommand({ moduleId: '09', motorId: '07', type: '03', deviceType: 5 });
  await delay(3000);
  
  console.log('✅ Drum descended');
  showMenu();
}

async function step6_beltForwardToBin(duration) {
  console.log(`\n➡️ STEP 6: Belt forward to BIN for ${duration}ms...`);
  console.log(`📍 Starting position: ${beltPosition}`);
  console.log(`⚠️ Watch the physical belt movement!`);
  
  // Start belt
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '02', deviceType: 1 });
  
  const startTime = Date.now();
  while (Date.now() - startTime < duration) {
    await delay(500);
    console.log(`   ${Date.now() - startTime}ms | Position: ${beltPosition} | Status: ${beltStatus}`);
  }
  
  // Stop belt
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 });
  console.log(`✅ Belt stopped at position: ${beltPosition}`);
  console.log(`❓ Did the bottle reach the bin? (observe physically)`);
  showMenu();
}

async function step7_beltReverse(duration) {
  console.log(`\n⬅️ STEP 7: Belt reverse for ${duration}ms...`);
  console.log(`📍 Starting position: ${beltPosition}`);
  
  // Start belt reverse
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '01', deviceType: 1 });
  
  const startTime = Date.now();
  while (Date.now() - startTime < duration) {
    await delay(500);
    console.log(`   ${Date.now() - startTime}ms | Position: ${beltPosition} | Status: ${beltStatus}`);
  }
  
  // Stop belt
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 });
  console.log(`✅ Belt reversed to position: ${beltPosition}`);
  showMenu();
}

async function step8_closeGate() {
  console.log('\n🚪 STEP 8: Closing gate...');
  await executeCommand({ moduleId: currentModuleId, motorId: '01', type: '00', deviceType: 1 });
  await delay(1000);
  console.log('✅ Gate closed');
  showMenu();
}

async function beltStop() {
  console.log('\n🛑 EMERGENCY STOP: Stopping belt...');
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 });
  console.log('✅ Belt stopped');
  showMenu();
}

async function resetAll() {
  console.log('\n🔄 RESETTING ALL...');
  
  // Stop all motors
  await executeCommand({ moduleId: currentModuleId, motorId: '01', type: '00', deviceType: 1 });
  await executeCommand({ moduleId: currentModuleId, motorId: '02', type: '00', deviceType: 1 });
  await executeCommand({ moduleId: currentModuleId, motorId: '03', type: '00', deviceType: 1 });
  await executeCommand({ moduleId: currentModuleId, motorId: '04', type: '00', deviceType: 1 });
  await executeCommand({ moduleId: '09', motorId: '03', type: '00', deviceType: 5 });
  
  // Drum down
  await executeCommand({ moduleId: '09', motorId: '07', type: '03', deviceType: 5 });
  await delay(3000);
  
  console.log('✅ All motors reset');
  showMenu();
}

// ======= EXECUTE COMMAND =======
async function executeCommand(params) {
  const apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
  
  try {
    await axios.post(apiUrl, params, {
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
  console.log('🎛️  MANUAL STEP-BY-STEP CONTROL');
  console.log('========================================');
  console.log(`📍 Belt Position: ${beltPosition} | Status: ${beltStatus}`);
  console.log(`📍 Drum Position: ${drumPosition}`);
  console.log('========================================');
  console.log('SEQUENCE STEPS:');
  console.log('1️⃣  Step 1: Open Gate');
  console.log('2️⃣  Step 2: Belt Forward 3s (to weight)');
  console.log('3️⃣  Step 3: Drum UP (lift & center)');
  console.log('4️⃣  Step 4: Get Weight');
  console.log('5️⃣  Step 5: Drum DOWN');
  console.log('6️⃣  Step 6: Belt Forward 12s (to bin) ⚠️ CRITICAL');
  console.log('7️⃣  Step 7: Belt Reverse 10s (to start)');
  console.log('8️⃣  Step 8: Close Gate');
  console.log('---');
  console.log('MANUAL BELT TESTING:');
  console.log('f2  Forward 2 seconds');
  console.log('f5  Forward 5 seconds');
  console.log('f10 Forward 10 seconds');
  console.log('f15 Forward 15 seconds');
  console.log('r5  Reverse 5 seconds');
  console.log('r10 Reverse 10 seconds');
  console.log('---');
  console.log('s   STOP belt (emergency)');
  console.log('r   RESET all motors');
  console.log('q   Quit');
  console.log('========================================');
  console.log('💡 TIP: Watch the PHYSICAL belt as it moves!');
  console.log('========================================\n');
}

// ======= USER INPUT =======
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', async (input) => {
  const cmd = input.trim().toLowerCase();
  
  switch (cmd) {
    case '1':
      await step1_openGate();
      break;
    case '2':
      await step2_beltForward(3000);
      break;
    case '3':
      await step3_drumUp();
      break;
    case '4':
      await step4_getWeight();
      break;
    case '5':
      await step5_drumDown();
      break;
    case '6':
      await step6_beltForwardToBin(12000);
      break;
    case '7':
      await step7_beltReverse(10000);
      break;
    case '8':
      await step8_closeGate();
      break;
    case 'f2':
      await step2_beltForward(2000);
      break;
    case 'f5':
      await step2_beltForward(5000);
      break;
    case 'f10':
      await step2_beltForward(10000);
      break;
    case 'f15':
      await step2_beltForward(15000);
      break;
    case 'r5':
      await step7_beltReverse(5000);
      break;
    case 'r10':
      await step7_beltReverse(10000);
      break;
    case 's':
      await beltStop();
      break;
    case 'r':
      await resetAll();
      break;
    case 'q':
      console.log('\n👋 Exiting...');
      process.exit(0);
      break;
    default:
      console.log('⚠️ Invalid command');
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
console.log('🧪 MANUAL STEP-BY-STEP CONTROL');
console.log('========================================');
console.log('Connecting to RVM system...');
console.log('This tool lets you execute each step manually');
console.log('to observe what is actually happening.');
console.log('========================================\n');