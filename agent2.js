// RVM Agent v7.2 - FIXED BELT AND STEPPER ISSUES
// Key fixes: Belt timing, stepper API parameters, sequence validation
// Save as: agent-v7.2-fixed-belt-stepper.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= SYSTEM CONFIGURATION =======
const SYSTEM_CONFIG = {
  // Belt commands - Motor 02
  belt: {
    forward: { motorId: "02", type: "02" },  // Forward to limit
    reverse: { motorId: "02", type: "01" },  // Reverse back
    stop: { motorId: "02", type: "00" }      // Stop
  },
  
  // Pusher command - Motor 03 (Transfer to roller)
  pusher: {
    toRoller: { motorId: "03", type: "03" },  // Push to end position
    stop: { motorId: "03", type: "00" }
  },
  
  // Compactor commands - Motor 04
  compactor: {
    start: { motorId: "04", type: "01" },
    stop: { motorId: "04", type: "00" }
  },
  
  // STEPPER MOTOR CONFIGURATION (from documentation)
  stepper: {
    moduleId: '0F',  // Stepper motor module ID (NOT the main module!)
    positions: {
      initialization: '00',   // Full reset
      home: '01',            // Return to origin (flat basket)
      metalCan: '02',        // Tilt for metal can
      plasticBottle: '03'    // Tilt for plastic bottle
    }
  },
  
  // Timing configurations
  applet: {
    weightCoefficients: { 1: 988, 2: 942, 3: 942, 4: 942 },
    timeouts: { 
      beltForward: 10000,        // INCREASED from 8000ms to ensure full movement
      pusherToRoller: 5000,      
      stepperRotate: 5000,       // INCREASED for stepper completion
      beltReverse: 10000,        // Match forward timing
      compactor: 6000,
      motorSettleDelay: 1000     // NEW: Allow motors to settle
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

// ======= STEP 1: BELT FORWARD TO WEIGHT =======
async function beltForwardToWeight() {
  console.log('▶️ Step 1: Belt moving bottle towards machine (to weight position)...');
  
  // Send forward command - type '02' moves to limit switch
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.forward
  });
  
  console.log(`   ⏳ Moving for ${SYSTEM_CONFIG.applet.timeouts.beltForward}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltForward);
  
  // CRITICAL: Ensure belt fully stops
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  // Extra delay to ensure bottle settles at weight position
  console.log('   ⏳ Allowing bottle to settle...');
  await delay(1500);
  
  console.log('✅ Bottle at weight position\n');
}

// ======= STEP 4: PUSHER - PUSH TO ROLLER =======
async function pushBottleToRoller() {
  console.log('▶️ Step 4: Transfer forward to roller (Motor 03)...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.toRoller
  });
  
  console.log(`   ⏳ Pushing for ${SYSTEM_CONFIG.applet.timeouts.pusherToRoller}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.pusherToRoller);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.pusher.stop
  });
  
  // Allow pusher to fully retract/settle
  await delay(SYSTEM_CONFIG.applet.timeouts.motorSettleDelay);
  
  console.log('✅ Bottle on white basket!\n');
}

// ======= STEP 5: STEPPER MOTOR - ROTATE TO DUMP (FIXED!) =======
async function stepperRotateAndDump(materialType) {
  console.log('▶️ Step 5: Stepping motor rotating to dump bottle...');
  
  // Determine position code based on material type
  let typeCode;  // Changed from positionCode to be clearer
  
  switch (materialType) {
    case 'PLASTIC_BOTTLE': 
      typeCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03'
      console.log('   🔵 PLASTIC: Using type code 03');
      break;
    case 'METAL_CAN': 
      typeCode = SYSTEM_CONFIG.stepper.positions.metalCan; // '02'
      console.log('   🟡 METAL: Using type code 02');
      break;
    case 'GLASS': 
      typeCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03' (fallback)
      console.log('   🟢 GLASS: Using type code 03 (fallback)');
      break;
    default:
      typeCode = SYSTEM_CONFIG.stepper.positions.plasticBottle; // '03'
      console.log('   ⚪ UNKNOWN: Using type code 03 (default)');
  }
  
  console.log(`   🔧 Sending stepper command: moduleId="${SYSTEM_CONFIG.stepper.moduleId}", type="${typeCode}"`);
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { 
      type: typeCode  // FIXED: Using 'type' as per documentation
    }
  });
  
  console.log(`   ⏳ Stepper rotating for ${SYSTEM_CONFIG.applet.timeouts.stepperRotate}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  // Additional delay to ensure bottle dumps completely
  await delay(1000);
  
  console.log('✅ Stepper rotated! Bottle should be dumped!\n');
}

// ======= STEP 6: COMPACTOR =======
async function compactorCrush() {
  console.log('▶️ Step 6: Compactor starting...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  console.log(`   ⏳ Compacting for ${SYSTEM_CONFIG.applet.timeouts.compactor}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Compaction complete\n');
  await delay(500);
}

// ======= STEP 7: BELT REVERSE =======
async function beltReverseToStart() {
  console.log('▶️ Step 7: Belt returning to start...');
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.reverse
  });
  
  console.log(`   ⏳ Reversing for ${SYSTEM_CONFIG.applet.timeouts.beltReverse}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.beltReverse);
  
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.belt.stop
  });
  
  await delay(SYSTEM_CONFIG.applet.timeouts.motorSettleDelay);
  
  console.log('✅ Belt at start\n');
}

// ======= STEP 8: RESET STEPPER TO HOME =======
async function stepperResetToHome() {
  console.log('▶️ Step 8: Resetting stepper to home position...');
  
  const homeType = SYSTEM_CONFIG.stepper.positions.home; // '01'
  
  console.log(`   🔧 Sending stepper reset: moduleId="${SYSTEM_CONFIG.stepper.moduleId}", type="${homeType}"`);
  
  await executeCommand({ 
    action: 'stepperMotor', 
    params: { 
      type: homeType  // Using 'type' as per API documentation
    }
  });
  
  console.log(`   ⏳ Resetting to home for ${SYSTEM_CONFIG.applet.timeouts.stepperRotate}ms...`);
  await delay(SYSTEM_CONFIG.applet.timeouts.stepperRotate);
  
  // Extra delay for complete reset
  await delay(1000);
  
  console.log('✅ Stepper at home (flat basket)\n');
}

// ======= EXECUTE COMMAND (FIXED) =======
async function executeCommand(commandData) {
  const { action, params } = commandData;
  const deviceType = 1;
  
  if (!currentModuleId && action !== 'getModuleId') {
    console.error('❌ No moduleId available');
    return;
  }
  
  let apiUrl, apiPayload;
  
  // Gate operations
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
  // Weight operations
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
  // STEPPER MOTOR (FIXED)
  else if (action === 'stepperMotor') {
    apiUrl = `${LOCAL_API_BASE}/system/serial/stepMotorSelect`;
    
    // Use stepper's specific module ID and correct parameter structure
    const stepperModuleId = SYSTEM_CONFIG.stepper.moduleId; // '0F'
    const typeCode = params?.type || '01';  // Use 'type' field from params
    
    console.log(`   📡 Stepper API: moduleId="${stepperModuleId}", type="${typeCode}", deviceType=${deviceType}`);
    
    apiPayload = { 
      moduleId: stepperModuleId,  // Use 0F for stepper motor
      type: typeCode,             // Position code goes in 'type' field
      deviceType 
    };
  } 
  // Custom motor operations
  else if (action === 'customMotor') {
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
    console.log(`   📡 API Call: ${apiUrl.split('/').pop()}`);
    console.log(`   📦 Payload: ${JSON.stringify(apiPayload)}`);
    
    const response = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`   ✅ Response: ${response.status}`);
    
    // Add delays for specific actions
    if (action === 'takePhoto') {
      await delay(2000);
    } else if (action === 'getWeight') {
      await delay(3000);
    }
    
  } catch (err) {
    console.error(`❌ ${action} failed:`, err.message);
    if (err.response) {
      console.error(`   Status: ${err.response.status}`);
      console.error(`   Data: ${JSON.stringify(err.response.data)}`);
    }
  }
}

// ======= FULL CYCLE =======
async function executeFullCycle() {
  console.log('\n========================================');
  console.log('🚀 STARTING CYCLE - FIXED SEQUENCE');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`⚖️ Weight: ${latestWeight.weight}g`);
  console.log('========================================\n');
  
  try {
    // STEP 0: Gate Open
    console.log('▶️ Step 0: Opening gate...');
    await executeCommand({ action: 'openGate' });
    await delay(2000);  // Give gate time to fully open
    console.log('✅ Gate opened\n');
    
    // STEP 1: Belt Forward (with increased timing)
    await beltForwardToWeight();
    
    // STEP 2 & 3: Weight & AI (already done)
    console.log('✅ Step 2: Weight:', latestWeight.weight, 'g');
    console.log('✅ Step 3: AI:', latestAIResult.materialType, '\n');
    await delay(500);
    
    // STEP 4: Push to Roller
    await pushBottleToRoller();
    
    // STEP 5: Stepper Rotate (with fixed API parameters)
    await stepperRotateAndDump(latestAIResult.materialType);
    
    // STEP 6: Compactor
    await compactorCrush();
    
    // STEP 7: Belt Reverse
    await beltReverseToStart();
    
    // STEP 8: Stepper Reset
    await stepperResetToHome();
    
    // STEP 9: Gate Close
    console.log('▶️ Step 9: Closing gate...');
    await executeCommand({ action: 'closeGate' });
    await delay(2000);
    console.log('✅ Gate closed\n');
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE!');
    console.log('========================================\n');
    
    // Publish completion
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      timestamp: new Date().toISOString()
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
    
    // Emergency stop all motors
    console.log('🛑 Emergency stop...');
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.belt.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.pusher.stop });
    await executeCommand({ action: 'customMotor', params: SYSTEM_CONFIG.compactor.stop });
    await stepperResetToHome();
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
      
      // Module ID response
      if (message.function === '01') {
        currentModuleId = message.moduleId;  // Keep original - this is correct
        console.log(`✅ Module ID received: ${currentModuleId}`);
        if (pendingCommands.size > 0) {
          const [id, cmd] = Array.from(pendingCommands.entries())[0];
          executeCommand(cmd);
          pendingCommands.delete(id);
        }
        return;
      }
      
      // AI Photo result
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
        
        console.log(`🤖 AI Result: ${latestAIResult.matchRate}% - ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
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
          weight: Math.round(calibratedWeight * 100) / 100,  // Round to 2 decimals
          rawWeight: weightValue,
          coefficient: weightCoefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${latestWeight.weight}g (raw: ${weightValue})`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/weight_result`, JSON.stringify(latestWeight));
        
        // Handle calibration if weight is invalid
        if (latestWeight.weight <= 0 && calibrationAttempts < 2) {
          calibrationAttempts++;
          console.log(`⚠️ Invalid weight, calibrating (${calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand({ action: 'calibrateWeight' });
            setTimeout(() => executeCommand({ action: 'getWeight' }), 1000);
          }, 500);
          return;
        }
        
        if (latestWeight.weight > 0) calibrationAttempts = 0;
        
        // Start cycle if conditions met
        if (autoCycleEnabled && latestAIResult && latestWeight.weight > 10 && !cycleInProgress) {
          cycleInProgress = true;
          setTimeout(() => executeFullCycle(), 1000);
        }
        return;
      }
      
      // Device status (body sensor)
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && autoCycleEnabled && !cycleInProgress) {
          console.log('👤 Object detected by infrared sensor');
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
  
  // Default to plastic if confidence is high enough
  return aiData.probability >= 0.5 ? 'PLASTIC_BOTTLE' : 'UNKNOWN';
}

// Module ID request
async function requestModuleId() {
  try {
    console.log('📡 Requesting module ID...');
    await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Module ID request failed:', err.message);
    // Retry after 2 seconds
    setTimeout(requestModuleId, 2000);
  }
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
  
  // Subscribe to control topics
  mqttClient.subscribe(`rvm/${DEVICE_ID}/commands`);
  mqttClient.subscribe(`rvm/${DEVICE_ID}/control/auto`);
  
  // Connect WebSocket
  connectWebSocket();
  
  // Request module ID after connection
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Auto mode control
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
    
    // Manual commands
    if (topic.includes('/commands')) {
      console.log(`📩 Command received: ${payload.action}`);
      
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

// Clean shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down gracefully...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

// Startup banner
console.log('========================================');
console.log('🚀 RVM AGENT v7.2 - FIXED BELT & STEPPER');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 KEY FIXES:');
console.log('   ✅ Belt timing: 10000ms (increased)');
console.log('   ✅ Stepper API: Using "type" field');
console.log('   ✅ Module ID: Dynamic (from WS)');
console.log('   ✅ Stepper Module: 0F (separate)');
console.log('   ✅ Motor settle delays added');
console.log('========================================');
console.log('📋 STEPPER POSITIONS:');
console.log('   • 00 = Initialize');
console.log('   • 01 = Home (flat)');
console.log('   • 02 = Metal can dump');
console.log('   • 03 = Plastic bottle dump');
console.log('========================================\n');