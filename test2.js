// RVM Agent v7.7 - OPTIMIZED FAST CYCLE WITH REALISTIC DETECTION
// IMPROVEMENTS:
// - Realistic confidence thresholds for real-world use
// - Metal cans: 22% | Plastic: 30% | Glass: 25%
// - INCREASED crushing time: 10 seconds (was 4s) for complete crushing
// - Better material detection with detailed logging
// - Manual material override option
// Save as: agent-v7.7-fast-cycle.js

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
  
  // DETECTION CONFIDENCE THRESHOLDS - REALISTIC FOR REAL-WORLD USE
  detection: {
    minConfidence: 0.25,     // 25% absolute minimum - practical threshold
    warningThreshold: 0.40,  // 40% - shows warning but accepts
    goodThreshold: 0.60,     // 60% - considered good detection
    thresholdByMaterial: {
      METAL_CAN: 0.22,       // 22% - metal cans are hardest to detect
      PLASTIC_BOTTLE: 0.30,  // 30% - plastic bottles
      GLASS: 0.25            // 25% - glass items
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
      compactor: 10000,          // INCREASED: 10 seconds for complete crushing (was 4s)
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

// ======= IMPROVED MATERIAL DETECTION WITH REALISTIC THRESHOLDS =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  const confidencePercent = Math.round(probability * 100);
  
  console.log('\n========================================');
  console.log('🔍 AI DETECTION ANALYSIS');
  console.log('========================================');
  console.log(`📝 Raw className: "${aiData.className}"`);
  console.log(`📊 Confidence: ${confidencePercent}%`);
  
  // Determine material type first
  let detectedType = 'UNKNOWN';
  let materialThreshold = SYSTEM_CONFIG.detection.minConfidence;
  
  // Metal can detection (check first - most specific)
  if (className.includes('易拉罐') || 
      className.includes('metal') || 
      className.includes('can') ||
      className.includes('tin') ||
      className.includes('aluminum') ||
      className.includes('aluminium') ||
      className.includes('铁罐') ||
      className.includes('金属') ||
      className.includes('铝罐') ||
      className.includes('铝')) {
    detectedType = 'METAL_CAN';
    materialThreshold = SYSTEM_CONFIG.detection.thresholdByMaterial.METAL_CAN;
  }
  // Plastic bottle detection
  else if (className.includes('pet') || 
      className.includes('plastic') || 
      className.includes('bottle') ||
      className.includes('瓶') ||
      className.includes('塑料') ||
      className.includes('饮料')) {
    detectedType = 'PLASTIC_BOTTLE';
    materialThreshold = SYSTEM_CONFIG.detection.thresholdByMaterial.PLASTIC_BOTTLE;
  }
  // Glass detection
  else if (className.includes('玻璃') || 
      className.includes('glass')) {
    detectedType = 'GLASS';
    materialThreshold = SYSTEM_CONFIG.detection.thresholdByMaterial.GLASS;
  }
  
  // Check if confidence meets material-specific threshold
  if (detectedType !== 'UNKNOWN') {
    const thresholdPercent = Math.round(materialThreshold * 100);
    
    if (probability < materialThreshold) {
      console.log(`❌ REJECTED: ${detectedType} detected but confidence too low`);
      console.log(`   Confidence: ${confidencePercent}% < ${thresholdPercent}% (threshold)`);
      console.log('   💡 Action: Please reposition item and try again');
      console.log('========================================\n');
      return 'UNKNOWN';
    }
    
    // Show confidence level indicator
    let confidenceLevel = '⚠️ LOW';
    let confidenceEmoji = '🟡';
    if (probability >= SYSTEM_CONFIG.detection.goodThreshold) {
      confidenceLevel = '✅ EXCELLENT';
      confidenceEmoji = '🟢';
    } else if (probability >= SYSTEM_CONFIG.detection.warningThreshold) {
      confidenceLevel = '✓ ACCEPTABLE';
      confidenceEmoji = '🟡';
    } else {
      confidenceLevel = '⚠️ LOW (but accepted)';
      confidenceEmoji = '🟠';
    }
    
    console.log(`${confidenceEmoji} ${confidenceLevel} - ${detectedType} detected (${confidencePercent}%)`);
    console.log(`   Required: ${thresholdPercent}% | Got: ${confidencePercent}%`);
    
    switch (detectedType) {
      case 'METAL_CAN':
        console.log('🟡 Will sort to: Position 02 (Metal bin)');
        break;
      case 'PLASTIC_BOTTLE':
        console.log('🔵 Will sort to: Position 03 (Plastic bin)');
        break;
      case 'GLASS':
        console.log('🟢 Will sort to: Position 03 (Glass bin)');
        break;
    }
    console.log('========================================\n');
    return detectedType;
  }
  
  // No keyword match
  console.log(`⚠️ WARNING: No keyword match in className`);
  console.log(`   Confidence: ${confidencePercent}%`);
  console.log(`   Decision: UNKNOWN (cannot classify)`);
  console.log('========================================\n');
  return 'UNKNOWN';
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

// ======= STEP 5: COMPACTOR CRUSH (EXTENDED TIME) =======
async function compactorCrush() {
  console.log('▶️ Step 5: Crushing bottle...');
  
  // Start compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.start
  });
  
  console.log(`   ⏳ Crushing: ${SYSTEM_CONFIG.applet.timeouts.compactor}ms (10 seconds for complete crushing)`);
  console.log('   💪 Extended crushing time ensures full bottle compression');
  await delay(SYSTEM_CONFIG.applet.timeouts.compactor);
  
  // Stop compactor
  await executeCommand({ 
    action: 'customMotor', 
    params: SYSTEM_CONFIG.compactor.stop
  });
  
  console.log('✅ Crushing complete - bottle fully compressed\n');
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
  console.log('🚀 STARTING FAST CYCLE v7.7');
  console.log('========================================');
  console.log(`📍 Material: ${latestAIResult.materialType}`);
  console.log(`📊 Confidence: ${latestAIResult.matchRate}%`);
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
    
    // STEP 5: Compactor (Extended crushing time)
    await compactorCrush();
    
    // STEP 6: Belt Return
    await beltReturnToStart();
    
    // STEP 7: Stepper Reset
    await stepperReset();
    
    // STEP 8: Gate Close
    await closeGate();
    
    console.log('========================================');
    console.log('✅ FAST CYCLE COMPLETE!');
    console.log('⏱️  Total time: ~31 seconds (with extended crushing)');
    console.log('========================================\n');
    
    // Publish success
    mqttClient.publish(`rvm/${DEVICE_ID}/cycle_complete`, JSON.stringify({
      material: latestAIResult.materialType,
      weight: latestWeight.weight,
      confidence: latestAIResult.matchRate,
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
      
      // AI Photo result
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        console.log(`\n🔍 DEBUG - AI Raw Response:`);
        console.log(`   className: "${aiData.className}"`);
        console.log(`   probability: ${probability} (${Math.round(probability * 100)}%)`);
        console.log(`   taskId: ${aiData.taskId}`);
        
        latestAIResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI FINAL RESULT: ${latestAIResult.matchRate}% - ${latestAIResult.materialType}`);
        
        mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
        
        // UPDATED: Use material-specific thresholds
        if (autoCycleEnabled && latestAIResult.materialType !== 'UNKNOWN') {
          const materialType = latestAIResult.materialType;
          const threshold = SYSTEM_CONFIG.detection.thresholdByMaterial[materialType] || SYSTEM_CONFIG.detection.minConfidence;
          const thresholdPercent = Math.round(threshold * 100);
          
          if (latestAIResult.matchRate >= thresholdPercent) {
            console.log(`✅ Confidence ${latestAIResult.matchRate}% meets ${materialType} threshold (${thresholdPercent}%)`);
            console.log('   Proceeding to weight measurement...\n');
            setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
          } else {
            console.log(`⚠️ Confidence ${latestAIResult.matchRate}% below ${materialType} threshold (${thresholdPercent}%)`);
            console.log('   Item rejected - please try again\n');
          }
        } else if (latestAIResult.materialType === 'UNKNOWN') {
          console.log('⚠️ Item not recognized - please remove and try again\n');
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
          console.log('👤 Object detected - Taking photo...');
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
  
  connectWebSocket();
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
    
    // Command handling
    if (topic.includes('/commands')) {
      console.log(`📩 Command: ${payload.action}`);
      
      // MANUAL MATERIAL OVERRIDE
      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          latestAIResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL_OVERRIDE',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`\n🔧 MANUAL MATERIAL OVERRIDE`);
          console.log(`   Material set to: ${payload.materialType}`);
          console.log(`   Confidence: 100% (manual)\n`);
          
          mqttClient.publish(`rvm/${DEVICE_ID}/ai_result`, JSON.stringify(latestAIResult));
          
          // Trigger weight check if auto mode enabled
          if (autoCycleEnabled) {
            console.log('   Triggering weight measurement...\n');
            setTimeout(() => executeCommand({ action: 'getWeight' }), 500);
          }
        } else {
          console.log(`❌ Invalid material type: ${payload.materialType}`);
          console.log(`   Valid types: ${validMaterials.join(', ')}\n`);
        }
        return;
      }
      
      // Regular command handling
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
console.log('🚀 RVM AGENT v7.7 - FAST CYCLE');
console.log(`📱 Device: ${DEVICE_ID}`);
console.log('========================================');
console.log('🔧 OPTIMIZED PROCESS:');
console.log('   1. Gate opens → Place bottle');
console.log('   2. Belt moves to weight (type 02, 3s)');
console.log('   3. Belt continues to stepper (type 03, 4s)');
console.log('   4. Stepper tilts (4s) → Dump to crusher');
console.log('   5. Compactor crushes (10s) ⚡ EXTENDED TIME');
console.log('   6. Belt returns (5s)');
console.log('   7. Stepper resets (6s)');
console.log('   8. Gate closes (1s)');
console.log('   ⏱️  TOTAL: ~31 seconds');
console.log('========================================');
console.log('🎯 DETECTION SETTINGS (REAL-WORLD):');
console.log(`   Metal cans: ${SYSTEM_CONFIG.detection.thresholdByMaterial.METAL_CAN * 100}% (hardest to detect)`);
console.log(`   Plastic: ${SYSTEM_CONFIG.detection.thresholdByMaterial.PLASTIC_BOTTLE * 100}%`);
console.log(`   Glass: ${SYSTEM_CONFIG.detection.thresholdByMaterial.GLASS * 100}%`);
console.log(`   Warning level: ${SYSTEM_CONFIG.detection.warningThreshold * 100}%`);
console.log(`   Good level: ${SYSTEM_CONFIG.detection.goodThreshold * 100}%`);
console.log('========================================');
console.log('💪 CRUSHING CONFIGURATION:');
console.log(`   Crushing time: ${SYSTEM_CONFIG.applet.timeouts.compactor / 1000} seconds`);
console.log('   Ensures complete bottle compression');
console.log('========================================');
console.log('📡 MANUAL OVERRIDE COMMAND:');
console.log('   Topic: rvm/RVM-3101/commands');
console.log('   Payload: {"action":"setMaterial","materialType":"METAL_CAN"}');
console.log('   Valid types: METAL_CAN, PLASTIC_BOTTLE, GLASS');
console.log('========================================\n');
console.log('⏳ Waiting for connections...\n');
