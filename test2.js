// RVM Agent v7.4 - FIXED MATERIAL DETECTION
// FIXES:
// - Improved AI material classification logic
// - Better debugging for AI results
// - Manual material override via MQTT
// Save as: agent-v7.4-fixed-material.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands (Motor 02) - Using type 02 for shorter movement
  belt: {
    toWeight: { motorId: "02", type: "02" },  // Short move to weight position
    toStepper: { motorId: "02", type: "03" }, // Full move to stepper position
    reverse: { motorId: "02", type: "01" },   // Return to start
    stop: { motorId: "02", type: "00" }       // Stop belt
  },
  
  // Compactor commands (Motor 04)
  compactor: {
    start: { motorId: "04", type: "01" },    // Start crushing
    stop: { motorId: "04", type: "00" }      // Stop crushing
  },
  
  // STEPPER MOTOR POSITION CODES (Module 09)
  stepper: {
    moduleId: '09',
    positions: {
      initialization: '00',
      home: '01',
      metalCan: '02',
      plasticBottle: '03'
    }
  },
  
  // OPTIMIZED TIMING CONFIGURATIONS
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltToWeight: 3000,        // SHORT movement to weight position
      beltToStepper: 4000,       // Movement from weight to stepper
      beltReverse: 5000,         // Faster return
      stepperRotate: 4000,       // Faster tilt
      stepperReset: 6000,        // Faster reset
      compactor: 4000,           // Faster crushing
      positionSettle: 500,       // Reduced settle time
      gateOperation: 1000        // Faster gate operation
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
let autoCycleEnabled = false;
let cycleInProgress = false;
let calibrationAttempts = 0;
let ws = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======= IMPROVED MATERIAL DETECTION =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  console.log(`🔍 RAW AI DETECTION: "${className}" (${Math.round(probability * 100)}%)`);

  // METAL DETECTION - Most specific keywords first
  if (className.includes('易拉罐') || className.includes('铝罐') || 
      className.includes('金属罐') || className.includes('metal') || 
      className.includes('can') || className.includes('aluminum') ||
      className.includes('罐')) {
    console.log('🟡 CONFIRMED: METAL CAN');
    return 'METAL_CAN';
  }
  
  // PLASTIC DETECTION
  if (className.includes('pet') || className.includes('塑料') || 
      className.includes('plastic') || className.includes('瓶') ||
      className.includes('pet瓶') || className.includes('饮料瓶') ||
      className.includes('塑料瓶')) {
    console.log('🔵 CONFIRMED: PLASTIC BOTTLE');
    return 'PLASTIC_BOTTLE';
  }
  
  // GLASS DETECTION
  if (className.includes('玻璃') || className.includes('glass') || 
      className.includes('酒瓶') || className.includes('beer') || 
      className.includes('wine') || className.includes('玻璃瓶')) {
    console.log('🟢 CONFIRMED: GLASS');
    return 'GLASS';
  }

  // FALLBACK: If no specific keywords found, use probability-based decision
  console.log(`❓ UNCLEAR: Using probability fallback (${Math.round(probability * 100)}%)`);
  
  if (probability >= 0.7) {
    console.log('⚪ HIGH CONFIDENCE: Defaulting to PLASTIC');
    return 'PLASTIC_BOTTLE';
  } else if (probability >= 0.4) {
    console.log('⚪ MEDIUM CONFIDENCE: Defaulting to METAL');
    return 'METAL_CAN';
  } else {
    console.log('❓ LOW CONFIDENCE: UNKNOWN material');
    return 'UNKNOWN';
  }
}

// ======= STEP 1: GATE OPEN =======
async function openGateForBottle() {
  console.log('▶️ Step 1: Opening gate for bottle placement...');
  await executeCommand({ action: 'openGate' });
  await delay(SYSTEM_CONFIG.applet.timeouts.gateOperation);
  console.log('✅ Gate opened - Place bottle now\n');
}

// ======= STEP 2: MOVE TO WEIGHT POSITION =======
async function moveToWeightPosition() {
  console.log('▶️ Step 2: Moving bottle to weight position...');
  console.log('   📏 Short belt movement: ' + SYSTEM_CONFIG.applet.timeouts.beltToWeight + 'ms');
  
  // Start belt movement to weight position
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.toWeight
  });
  
  // Wait for short movement
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToWeight);
  
  // Stop belt
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Bottle at weight position\n');
}

// ======= STEP 3: MOVE TO STEPPER POSITION =======
async function moveToStepperPosition() {
  console.log('▶️ Step 3: Moving bottle to stepper position...');
  console.log('   📏 Belt movement: ' + SYSTEM_CONFIG.applet.timeouts.beltToStepper + 'ms');
  
  // Start belt movement to stepper position
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.toStepper
  });
  
  // Wait for movement
  await delay(SYSTEM_CONFIG.applet.timeouts.beltToStepper);
  
  // Stop belt
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  // Allow position to settle
  await delay(SYSTEM_CONFIG.applet.timeouts.positionSettle);
  console.log('✅ Bottle at stepper position\n');
}

// ======= STEP 4: STEPPER MOTOR - DUMP BOTTLE =======
async function stepperDumpBottle(materialType) {
  console.log('▶️ Step 4: Tilting basket to dump bottle...');
  
  // Select position based on material type
  let positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // Default
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle;
      console.log('   🔵 PLASTIC: Position 03');
      break;
    case 'METAL_CAN': 
      positionCode = SYSTEM_CONFIG.stepper.positions.metalCan;
      console.log('   🟡 METAL: Position 02');
      break;
    case 'GLASS': 
      positionCode = SYSTEM_CONFIG.stepper.positions.plasticBottle;
      console.log('   🟢 GLASS: Position 03');
      break;
    default:
      console.log('   ⚪ UNKNOWN: Position 03');
  }
  
  console.log(`   🔧 Stepper tilt: ${SYSTEM_CONFIG.applet.timeouts.stepperRotate}ms`);
  
  // Send stepper command
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: positionCode }
  });
  
  // Wait for basket rotation
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  console.log('✅ Bottle dumped into crusher!\n');
}

// ======= STEP 5: COMPACTOR CRUSH =======
async function compactorCrush() {
  console.log('▶️ Step 5: Crushing bottle...');
  
  // Start compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  console.log(`   ⏳ Crushing: ${SYSTEM_CONFIG.applet.timeouts.compactor}ms`);
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  // Stop compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Crushing complete\n');
}

// ======= STEP 6: BELT RETURN =======
async function beltReturnToStart() {
  console.log('▶️ Step 6: Returning belt to start...');
  console.log('   📏 Belt return: ' + SYSTEM_CONFIG.applet.timeouts.beltReverse + 'ms');
  
  // Start belt reverse
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.reverse
  });
  
  // Wait for return
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  // Stop belt
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  console.log('✅ Belt at start position\n');
}

// ======= STEP 7: STEPPER RESET =======
async function stepperReset() {
  console.log('▶️ Step 7: Resetting stepper to home...');
  console.log(`   🔧 Stepper reset: ${SYSTEM_CONFIG.applet.timeouts.stepperReset}ms`);
  
  // Send reset command
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { position: SYSTEM_CONFIG.stepper.positions.home }
  });
  
  // Wait for reset
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperReset);
  
  console.log('✅ Stepper reset complete\n');
}

// ======= STEP 8: GATE CLOSE =======
async function closeGate() {
  console.log('▶️ Step 8: Closing gate...');
  await executeCommand({ action: 'closeGate' });
  await delay(SYSTEM_CONFIG.applet.timeouts.gateOperation);
  console.log('✅ Gate closed\n');
}

// ======= OPTIMIZED FAST CYCLE =======
async function executeFastCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING FAST CYCLE v7.4');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 1: Gate Open
    await openGateForBottle();
    
    // Wait for user to place bottle (simulated by object detection)
    console.log('⏳ Waiting for bottle placement...');
    await delay(2000); // Simulate user placing bottle
    
    // STEP 2: Move to Weight Position (Short movement)
    await moveToWeightPosition();
    
    // STEP 3: Move to Stepper Position (Continue movement)
    await moveToStepperPosition();
    
    // STEP 4: Stepper Dump
    await stepperDumpBottle(latestAIResult.materialType);
    
    // STEP 5: Compactor
    await compactorCrush();
    
    // STEP 6: Belt Return
    await beltReturnToStart();
    
    // STEP 7: Stepper Reset
    await stepperReset();
    
    // STEP 8: Gate Close
    await closeGate();
    
    console.log('========================================');
    console.log('✅ FAST CYCLE COMPLETE!');
    console.log('⏱️  Total time: ~25 seconds');
    console.log('========================================\n');
    
    // Publish success
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString(),
      cycleType: 'fast'
    }));
    
    // Reset state
    cycleInProgress = false;
    latestAIResult = null;
    latestWeight = null;
    
  } catch (err) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', err.message);
    console.error('========================================\n');
    cycleInProgress = false;
    
    // Emergency stop
    console.log('🛑 EMERGENCY STOP - Stopping all motors...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    
    // Reset systems
    await stepperReset();
    await closeGate();
    console.log('🛑 Emergency stop complete\n');
  }
}

// ======= EXECUTE COMMAND =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const deviceType = 1;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available');
    return;
  }
  
  let apiUrl, apiPayload;
  
  // Gate commands
  if (action === 'openGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '03', 
      deviceType 
    };
  } else if (action === 'closeGate') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = { 
      moduleId: currentModuleId, 
      motorId: '01', 
      type: '00', 
      deviceType 
    };
  } 
  // Weight commands
  else if (action === 'getWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/getWeight`;
    apiPayload = { 
      moduleId: currentModuleId, 
      type: '00' 
    };
  } else if (action === 'calibrateWeight') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/weightCalibration`;
    apiPayload = { 
      moduleId: currentModuleId, 
      type: '00' 
    };
  } 
  // Camera
  else if (action === 'takePhoto') {
    apiUrl = `${LOCAL_API_BASE}/system/camera/process`;
    apiPayload = {};
  } 
  // Stepper Motor
  else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    const stepperModuleId = SYSTEM_CONFIG.stepper.moduleId;
    const positionCode = params?.position || '01';
    
    console.log(`   📡 Stepper: moduleId="${stepperModuleId}", position="${positionCode}"`);
    
    apiPayload = { 
      moduleId: stepperModuleId,
      id: positionCode,
      type: positionCode,
      deviceType 
    };
  } 
  // Regular motors
  else if (action === 'customMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: currentModuleId,
      motorId: params?.motorId,
      type: params?.type,
      deviceType
    };
  } else {
    console.error('⚠️ Unknown action:', action);
    return;
  }
  
  try {
    console.log(`   📡 ${apiUrl.split('/').pop()}: ${JSON.stringify(apiPayload)}`);
    
    const response = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Add minimal delays for specific actions
    if (action === 'takePhoto') {
      await delay(1500);
    } else if (action === 'getWeight') {
      await delay(2000);
    }
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
    throw err;
  }
}

// ======= REQUEST MODULE ID =======
async function requestModuleId() {
  try {
    console.log('📡 Requesting module ID...');
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
  }
}

// ======= WEBSOCKET CONNECTION =======
function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID response
      if (message.function === '01') {
        currentModuleId = message.moduleId || message.data;
        console.log(`✅ Module ID received: ${currentModuleId}`);
        
        if (pendingCommands.size > 0) {
          const [id, cmd] = Array.from(pendingCommands.entries())[0];
          executeCommand(cmd);
          pendingCommands.delete(id);
        }
        return;
      }
      
      // AI Photo result - IMPROVED DEBUGGING
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        console.log('\n🤖 ====== AI RAW DATA ======');
        console.log('   Class Name:', aiData.className);
        console.log('   Probability:', probability);
        console.log('   Full AI Data:', JSON.stringify(aiData));
        console.log('============================\n');
        
        latestAIResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          rawClassName: aiData.className || '',
          probability: probability,
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 FINAL DECISION: ${latestAIResult.materialType} (${latestAIResult.matchRate}% confidence)`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        // Auto-cycle: get weight after AI
        if (autoCycleEnabled && latestAIResult.matchRate >= 30 && latestAIResult.materialType !== 'UNKNOWN') {
          setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
        }
        return;
      }
      
      // Weight result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const weightCoefficient = SYSTEM_CONFIG.applet.weightCoefficients[1];
        const calibratedWeight = weightValue * (weightCoefficient / 1000);
        
        latestWeight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g (raw: ${weightValue})`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        // Calibrate if needed
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        // Start FAST cycle if conditions met
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 1 && !cycleInProgress) {
          cycleInProgress = true;
          setTimeout(() => executeFastCycle(), 1000);
        }
        return;
      }
      
      // Device status (object detection)
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 Object detected - Starting process...');
          setTimeout(() => executeCommand({ action: 'takePhoto' }), 1000);
        }
        return;
      }
      
    } catch (err) {
      console.error('❌ WebSocket message error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => console.error('❌ WebSocket error:', err.message));
}

// ======= MQTT CONNECTION =======
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
  mqttClient.subscribe(`rvm/${DEVICE_ID}/material_override`); // NEW: Material override
  
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic.includes('/control/auto')) {
      autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 AUTO MODE: ${autoCycleEnabled ? 'ENABLED' : 'DISABLED'}`);
      
      if (autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'openGate' });
      } else if (!autoCycleEnabled && currentModuleId) {
        await executeCommand({ action: 'closeGate' });
      }
      return;
    }
    
    // NEW: Manual material override
    if (topic.includes('/material_override')) {
      console.log(`🎯 MANUAL OVERRIDE: ${payload.material}`);
      if (latestAIResult) {
        latestAIResult.materialType = payload.material;
        latestAIResult.manualOverride = true;
        console.log(`✅ Material overridden to: ${payload.material}`);
        
        // Start cycle if ready
        if (latestWeight && latestWeight.weight > 1 && !cycleInProgress) {
          cycleInProgress = true;
          setTimeout(() => executeFastCycle(), 1000);
        }
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
    console.error('❌ MQTT message error:', err.message);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down gracefully...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v7.4 - FIXED MATERIAL DETECTION');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 KEY IMPROVEMENTS:');
console.log('   ✅ Enhanced AI material classification');
console.log('   ✅ Better metal detection (易拉罐, 铝罐, metal, can)');
console.log('   ✅ Better plastic detection (塑料, pet, plastic, 瓶)');
console.log('   ✅ Better glass detection (玻璃, glass)');
console.log('   ✅ Detailed AI debugging output');
console.log('   ✅ Manual material override via MQTT');
console.log('========================================');
console.log('🎯 MANUAL OVERRIDE USAGE:');
console.log('   Send MQTT to: rvm/RVM-3101/material_override');
console.log('   { "material": "METAL_CAN" }');
console.log('   { "material": "PLASTIC_BOTTLE" }');
console.log('   { "material": "GLASS" }');
console.log('========================================\n');
console.log('⏳ Waiting for connections...\n');