// RVM Agent v6.8 - STEPPER MOTOR FIX - SIMPLIFIED
// Stepper motor (white basket) rotates AFTER bottle arrives to dump it into crusher
// Save as: agent-v6.8-stepper-dump-simple.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands (from 5.3, 5.4, 5.5)
  belt: {
    forwardToLimit: { motorId: "02", type: "02" },    // 5.3 - to limit switch
    reverseBack: { motorId: "02", type: "01" },       // 5.4 - reverse back  
    stop: { motorId: "02", type: "00" },              // 5.5 - stop
    forwardToSorter: { motorId: "03", type: "03" }    // 5.6 - to sorter (white basket)
  },
  
  // Compactor commands (from 5.7, 5.8)
  compactor: {
    start: { motorId: "04", type: "01" },             // 5.7 - start
    stop: { motorId: "04", type: "00" }               // 5.8 - stop
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      motor: 10000,
      beltToWeightPosition: 3000,
      beltToSorter: 5000,        // Time to move bottle to white basket
      beltReverse: 8000,         // Time for belt to return
      compactor: 6000,           // Compactor operation time
      sorterRotate: 4000,        // Time for basket to rotate and dump into crusher
      sorterHome: 2000           // Time to reset basket position
    }
  }
};

// ======= CONFIG =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';

// State
let currentModuleId = null;
let latestAIResult = null;
let latestWeight = null;
let pendingCommands = new Map();
let motorStatusCache = {};
let autoCycleEnabled = false;
let cycleInProgress = false;
let calibrationAttempts = 0;
let ws = null;
let lastBeltStatus = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= BELT CONTROL =======
async function beltForwardToWeightPosition() {
  console.log('🎯 Step 2: Belt moving bottle to weight position...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forwardToLimit
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToWeightPosition);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position');
  await delay(500);
}

async function beltForwardToSorter() {
  console.log('🎯 Step 4: Belt moving bottle to STEPPER MOTOR (white basket)...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forwardToSorter
  });
  
  console.log(`   Running for ${SYSTEM_CONFIG.applet.timeouts.beltToSorter}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToSorter);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle on white basket (stepper motor sorter)');
  await delay(1000); // Extra delay to ensure bottle is properly positioned
}

async function beltReverseToStart() {
  console.log('🔄 Step 6: Belt returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.reverseBack
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt at start position');
  await delay(500);
}

// ======= COMPACTOR =======
// async function compactorOperation() {
//   console.log('🔨 Step 7: Running compactor...');
  
//   await executeCommand({ 
//     action: 'customMotor', 
//     params: SYSTEM_CONFIG.compactor.start
//   });
  
//   await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
//   await executeCommand({ 
//     action: 'customMotor', 
//     params: SYSTEM_CONFIG.compactor.stop
//   });
  
//   console.log('✅ Compaction complete');
// }

async function compactorOperation() {
  console.log('🔨 Step 7: Running compactor...');
  
  // Forward compaction
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  // Reverse 3 seconds (per flowchart)
  console.log('   ⏪ Reversing compactor 3s...');
  await executeCommand({ 
    action: 'customMotor', 
    params: { motorId: '04', type: '02' }  // Type 02 = reverse
  });
  
  await delay(3000);
  
  // Stop compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Compaction complete');
}

// ======= STEPPER MOTOR (WHITE BASKET) CONTROL =======
async function dumpBottleIntoCrusher(materialType) {
  console.log('🔄 Step 5: STEPPER MOTOR - Rotating white basket to dump bottle INTO CRUSHER...');
  
  let sorterPosition = '03'; // Default plastic
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      sorterPosition = '03'; 
      console.log('   🔵 Rotating to PLASTIC crusher position (03)');
      break;
    case 'METAL_CAN': 
      sorterPosition = '02'; 
      console.log('   🟡 Rotating to METAL crusher position (02)');
      break;
    case 'GLASS': 
      sorterPosition = '01'; 
      console.log('   🟢 Rotating to GLASS crusher position (01)');
      break;
  }
  
  console.log('   ⚠️ White basket will now TILT/ROTATE to dump bottle INTO CRUSHER!');
  
  // Send stepper motor command to rotate basket (dump position)
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: sorterPosition }
  });
  
  console.log('   ⏳ Rotating basket to dump position...');
  await delay(SYSTEM_CONFIG.applet.timeouts.sorterRotate);
  
  console.log('✅ Basket rotated! Bottle should fall into crusher!');
  await delay(1500); // Extra delay for bottle to completely fall into crusher
}

async function resetSorterToHome() {
  console.log('🏠 Step 8: Resetting stepper motor (basket) to home position...');
  
  // Position 01 = Return to origin (home position)
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: '01' }
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.sorterHome);
  console.log('✅ Basket at home position (ready for next bottle)');
}

// ======= SIMPLIFIED CYCLE - NO DRUM OPERATIONS =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - STEPPER TO CRUSHER');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 1: Gate Open
    console.log('▶️ Step 1: Opening gate...');
    await executeCommand({ action: 'openGate' });
    await delay(1000);
    console.log('✅ Gate opened\n');
    
    // STEP 2: Belt Forward to Weight Position
    await beltForwardToWeightPosition();
    await delay(500);
    
    // STEP 3: Weight Confirmed (no drum operations)
    console.log('▶️ Step 3: Weight confirmed');
    console.log(`   ⚖️ ${latestWeight.weight}g\n`);
    await delay(500);
    
    // STEP 4: Belt Forward to Stepper Motor (white basket)
    await beltForwardToSorter();
    await delay(500);
    
    // STEP 5: STEPPER MOTOR ROTATES to dump bottle INTO CRUSHER
    await dumpBottleIntoCrusher(latestAIResult.materialType);
    await delay(500);
    
    // STEP 6: Belt Reverse
    await beltReverseToStart();
    await delay(500);
    
    // STEP 7: Compactor
    await compactorOperation();
    await delay(500);
    
    // STEP 8: Reset stepper motor to home
    await resetSorterToHome();
    await delay(500);
    
    // STEP 9: Gate Close
    console.log('▶️ Step 9: Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(1000);
    console.log('✅ Gate closed\n');
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE - BOTTLE IN CRUSHER!');
    console.log('========================================\n');
    
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString(),
      status: 'bottle_in_crusher'
    }));
    
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', err.message);
    console.error('========================================\n');
    cycleInProgress = false;
    
    // Emergency stop all motors
    console.log('🛑 Emergency stop...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    await resetSorterToHome();
    await executeCommand({ action: 'closeGate' });
  }
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
        if (pendingCommands.size > 0) {
          const [id, cmd] = Array.from(pendingCommands.entries())[0];
          executeCommand(cmd);
          pendingCommands.delete(id);
        }
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        latestAIResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${latestAIResult.matchRate}% - ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
          setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
        }
        return;
      }
      
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const weightCoefficient = SYSTEM_CONFIG.applet.weightCoefficients[1];
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: calibratedWeight,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ Calibrating (${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 10 && !cycleInProgress) {
          cycleInProgress = true;
          setTimeout(() => executeFullCycle(), 1000);
        }
        return;
      }
      
      if (message.function === '03') {
        try {
          const motors = JSON.parse(message.data);
          motors.forEach(motor => {
            motorStatusCache[motor.motorType] = motor;
            if (motor.motorType === '02') lastBeltStatus = motor;
          });
        } catch (err) {
          // Ignore
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 Object detected');
          setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
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

// ======= UTILITIES =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  
  if (className.includes('pet') || className.includes('plastic') || className.includes('瓶')) {
    return 'PLASTIC_BOTTLE';
  }
  if (className.includes('易拉罐') || className.includes('metal') || className.includes('can')) {
    return 'METAL_CAN';
  }
  if (className.includes('玻璃') || className.includes('glass')) {
    return 'GLASS';
  }
  
  return aiData.probability >= 0.5 ? 'PLASTIC_BOTTLE' : 'UNKNOWN';
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const deviceType = 1;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId');
    return;
  }
  
  let apiUrl, apiPayload;
  
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '03', deviceType };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { moduleId: currentModuleId, motorId: '01', type: '00', deviceType };
  } else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { moduleId: currentModuleId, type: '00' };
  } else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    apiPayload = { moduleId: currentModuleId, type: params?.position || '01', deviceType };
  } else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: params?.moduleId || currentModuleId,
      motorId: params?.motorId,
      type: params?.type,
      deviceType: params?.deviceType || deviceType
    };
  } else {
    console.error('⚠️ Unknown action:', action);
    return;
  }
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') {
      await delay(2000);
    } else if (action === 'getWeight') {
      await delay(3000);
    }
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
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

// ======= MQTT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  mqttClient.subscribe(`rvm/${DEVICE_ID}/commands`);
  mqttClient.subscribe(`rvm/${DEVICE_ID}/control/auto`);
  
  connectWebSocket();
  
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic.includes('/control/auto')) {
      autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 AUTO MODE: ${autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'openGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'closeGate' });
      }
      return;
    }
    
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (!currentModuleId) {
        pendingCommands.set(Date.now().toString(), payload);
        await requestModuleId();
      } else {
        await executeCommand(payload);
      }
    }
    
  } catch (err) {
    console.error('❌ MQTT error:', err.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('========================================');
console.log('🚀 RVM AGENT v6.8 - STEPPER TO CRUSHER');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('✅ SIMPLIFIED SEQUENCE:');
console.log('   1. Gate Open');
console.log('   2. Belt Forward → Weight position');
console.log('   3. Weight Detection');
console.log('   4. Belt Forward → White basket');
console.log('   5. Stepper Motor ROTATES basket 🔄');
console.log('      → Bottle falls INTO CRUSHER!');
console.log('   6. Belt Reverse');
console.log('   7. Compactor');
console.log('   8. Reset basket to home');
console.log('   9. Gate Close');
console.log('========================================');
console.log('🔧 KEY IMPROVEMENTS:');
console.log('   • Removed unnecessary drum operations');
console.log('   • Bottle now goes directly to white basket');
console.log('   • Stepper motor dumps bottle INTO CRUSHER');
console.log('   • Using correct motor IDs from doc 5.5-5.8');
console.log('========================================\n');