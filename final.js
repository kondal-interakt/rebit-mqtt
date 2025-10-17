// RVM Agent v9.1 - FULL AUTOMATION FIXED
// QR scanning now properly triggers complete automation
// Save as: agent-v9.1-fixed.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');

// ======= CONFIGURATION =======
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 10000
  },
  
  mqtt: {
    brokerUrl: 'mqtts://mqtt.ceewen.xyz:8883',
    username: 'mqttuser',
    password: 'mqttUser@2025',
    caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status',
      qrScan: 'rvm/RVM-3101/qr/scanned'
    }
  },
  
  qr: {
    minLength: 8,
    maxLength: 20, // Increased for your longer QR codes
    numericOnly: false // Allow alphanumeric
  },
  
  motors: {
    belt: {
      toWeight: { motorId: "02", type: "02" },
      toStepper: { motorId: "02", type: "03" },
      reverse: { motorId: "02", type: "01" },
      stop: { motorId: "02", type: "00" }
    },
    compactor: {
      start: { motorId: "04", type: "01" },
      stop: { motorId: "04", type: "00" }
    },
    stepper: {
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },
  
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 10000,
    positionSettle: 500,
    gateOperation: 1000,
    objectDetectionWait: 30000,
    betweenItemsDelay: 5000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ======= STATE =======
const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  sessionId: null,
  currentUserId: null,
  waitingForObject: false,
  objectDetectionTimer: null,
  itemCount: 0,
  maxItemsPerSession: 10,
  qrScanEnabled: true
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// ======= QR SCANNER SETUP =======
function setupQRScanner() {
  console.log('\n========================================');
  console.log('📱 SETTING UP QR SCANNER');
  console.log('========================================');
  console.log('⌨️  Listening for keyboard input...');
  console.log(`📏 Accepting QR codes: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars`);
  console.log('🎯 Auto mode: ON');
  console.log('========================================\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (input) => {
    if (!state.qrScanEnabled) {
      console.log('⚠️ QR scanning currently disabled');
      return;
    }
    
    const qrCode = input.trim();
    
    // Validate QR code
    if (qrCode.length >= CONFIG.qr.minLength && 
        qrCode.length <= CONFIG.qr.maxLength) {
      
      console.log(`\n📱 QR CODE RECEIVED: "${qrCode}"`);
      
      // Process QR code (this will trigger full automation)
      try {
        await processQRCode(qrCode);
      } catch (error) {
        console.error('❌ QR processing error:', error.message);
      }
    } else {
      console.log(`❌ Invalid QR format: "${qrCode}" (length: ${qrCode.length})`);
      console.log(`   Expected: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} characters`);
    }
  });

  console.log('✅ QR Scanner ready - waiting for scans...\n');
}

// ======= QR CODE PROCESSOR =======
async function processQRCode(qrCode) {
  const timestamp = new Date().toISOString();
  
  console.log('========================================');
  console.log('🎯 QR CODE SCANNED - STARTING AUTOMATION');
  console.log('========================================');
  console.log(`👤 User ID: ${qrCode}`);
  console.log(`📏 Length: ${qrCode.length} characters`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
  console.log(`🔧 Module ID: ${state.moduleId || 'CHECKING...'}`);
  console.log('========================================\n');
  
  // Verify module ID is available
  if (!state.moduleId) {
    console.log('⚠️ Module ID not available, requesting...');
    await requestModuleId();
    await delay(2000);
    
    if (!state.moduleId) {
      console.error('❌ Cannot start automation - Module ID unavailable');
      return;
    }
  }
  
  // Store user session info
  state.currentUserId = qrCode;
  state.itemCount = 0;
  state.sessionId = generateSessionId();
  
  console.log(`✅ Session created: ${state.sessionId}\n`);
  
  // Publish QR scan to MQTT
  const qrMessage = {
    deviceId: CONFIG.device.id,
    userId: qrCode,
    timestamp: timestamp,
    sessionId: state.sessionId,
    action: 'session_started'
  };
  
  mqttClient.publish(
    CONFIG.mqtt.topics.qrScan, 
    JSON.stringify(qrMessage), 
    { qos: 1 }
  );
  
  console.log('📤 Published to MQTT:', CONFIG.mqtt.topics.qrScan);
  
  // Send to WebSocket (if middleware needs it)
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const wsMessage = { function: "qrcode", data: qrCode };
    state.ws.send(JSON.stringify(wsMessage));
    console.log('📤 Sent to WebSocket\n');
  }
  
  // 🚀 START FULL AUTOMATION
  console.log('🚀 INITIATING FULL AUTOMATION SEQUENCE...\n');
  await startFullAutomationSequence();
}

// ======= FULL AUTOMATION SEQUENCE =======
async function startFullAutomationSequence() {
  try {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   FULL AUTOMATION SEQUENCE STARTED     ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    // Step 1: Enable auto mode
    console.log('▶️  Step 1: Enabling auto mode...');
    state.autoCycleEnabled = true;
    mqttClient.publish(
      CONFIG.mqtt.topics.autoControl, 
      JSON.stringify({ enabled: true })
    );
    await delay(500);
    console.log('✅ Auto mode: ENABLED\n');
    
    // Step 2: Reset system
    console.log('▶️  Step 2: Resetting system...');
    await resetSystemToReadyState();
    console.log('✅ System reset: COMPLETE\n');
    
    // Step 3: Open gate
    console.log('▶️  Step 3: Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate: OPEN\n');
    
    console.log('╔════════════════════════════════════════╗');
    console.log('║    🎉 READY FOR ITEMS! 🎉             ║');
    console.log('║    Please insert bottles/cans          ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    // Step 4: Start waiting for object
    startObjectDetectionWait();
    
  } catch (error) {
    console.error('╔════════════════════════════════════════╗');
    console.error('║    ❌ AUTOMATION FAILED!               ║');
    console.error('╚════════════════════════════════════════╝');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('\n');
  }
}

async function resetSystemToReadyState() {
  console.log('   🔧 Stopping all motors...');
  
  try {
    // Stop belt
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(200);
    
    // Stop compactor
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await delay(200);
    
    // Reset stepper to home
    console.log('   🔧 Resetting stepper to home position...');
    await executeCommand('stepperMotor', { 
      position: CONFIG.motors.stepper.positions.home 
    });
    await delay(2000);
    
    console.log('   ✅ All motors in safe state');
  } catch (error) {
    console.error('   ❌ System reset failed:', error.message);
    throw error;
  }
}

function startObjectDetectionWait() {
  console.log('⏳ WAITING FOR OBJECT DETECTION...');
  console.log(`   Timeout: ${CONFIG.timing.objectDetectionWait / 1000} seconds`);
  console.log(`   Items so far: ${state.itemCount}/${state.maxItemsPerSession}\n`);
  
  state.waitingForObject = true;
  
  // Set timeout
  state.objectDetectionTimer = setTimeout(async () => {
    if (state.waitingForObject) {
      console.log('\n⏰ TIMEOUT - No object detected');
      console.log('🚪 Closing gate and ending session...\n');
      
      state.waitingForObject = false;
      
      // Close gate
      try {
        await executeCommand('closeGate');
        console.log('✅ Session ended\n');
      } catch (error) {
        console.error('❌ Error closing gate:', error.message);
      }
      
      // Reset session
      state.currentUserId = null;
      state.itemCount = 0;
      state.autoCycleEnabled = false;
    }
  }, CONFIG.timing.objectDetectionWait);
}

// ======= MATERIAL DETECTION =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } else if (className.includes('pet') || className.includes('plastic') || 
             className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
  }
  
  const confidencePercent = Math.round(probability * 100);
  const thresholdPercent = Math.round(threshold * 100);
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    console.log(`⚠️ ${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`);
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    console.log(`✅ ${materialType} detected (${confidencePercent}%)`);
  }
  
  return materialType;
}

// ======= HARDWARE COMMANDS =======
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  
  if (!state.moduleId && action !== 'getModuleId') {
    throw new Error('Module ID not available');
  }
  
  let apiUrl, apiPayload;
  
  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      break;
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '00', deviceType };
      break;
    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      apiPayload = {};
      break;
    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      apiPayload = { 
        moduleId: CONFIG.motors.stepper.moduleId, 
        id: params.position, 
        type: params.position, 
        deviceType 
      };
      break;
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { 
        moduleId: state.moduleId, 
        motorId: params.motorId, 
        type: params.type, 
        deviceType 
      };
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  try {
    await axios.post(apiUrl, apiPayload, { 
      timeout: CONFIG.local.timeout, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
    // Small delays for specific actions
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    console.error(`❌ Command failed: ${action}`);
    console.error(`   URL: ${apiUrl}`);
    console.error(`   Error: ${error.message}`);
    throw error;
  }
}

// ======= AUTO CYCLE =======
async function executeAutoCycle() {
  if (state.cycleInProgress) {
    console.log('⚠️ Cycle already in progress, skipping...');
    return;
  }
  
  const cycleStartTime = Date.now();
  state.cycleInProgress = true;
  state.waitingForObject = false;
  
  // Clear timer
  if (state.objectDetectionTimer) {
    clearTimeout(state.objectDetectionTimer);
    state.objectDetectionTimer = null;
  }
  
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║       🚀 PROCESSING ITEM 🚀           ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`👤 User: ${state.currentUserId}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️  Weight: ${state.weight.weight}g`);
  console.log(`🔢 Item: ${state.itemCount + 1}/${state.maxItemsPerSession}`);
  console.log('════════════════════════════════════════\n');
  
  try {
    // Step 1: Close gate
    console.log('▶️  [1/8] Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    // Step 2: Belt to weight
    console.log('▶️  [2/8] Moving to weight position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 3: Belt to stepper
    console.log('▶️  [3/8] Moving to stepper position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    // Step 4: Stepper dump
    console.log('▶️  [4/8] Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    // Step 5: Compactor
    console.log('▶️  [5/8] Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // Step 6: Belt return
    console.log('▶️  [6/8] Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 7: Stepper reset
    console.log('▶️  [7/8] Resetting stepper...');
    await executeCommand('stepperMotor', { 
      position: CONFIG.motors.stepper.positions.home 
    });
    await delay(CONFIG.timing.stepperReset);
    
    // Step 8: Prepare for next item
    console.log('▶️  [8/8] Preparing for next item...');
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    state.itemCount++;
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║      ✅ ITEM PROCESSED! ✅            ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log(`🔢 Total items: ${state.itemCount}/${state.maxItemsPerSession}`);
    console.log('════════════════════════════════════════\n');
    
    // Publish transaction
    const transactionData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      rawWeight: state.weight.rawWeight,
      confidence: state.aiResult.matchRate,
      aiClassName: state.aiResult.className,
      aiTaskId: state.aiResult.taskId,
      cycleTime: cycleTime,
      itemCount: state.itemCount,
      timestamp: new Date().toISOString(),
      status: 'success'
    };
    
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete, 
      JSON.stringify(transactionData), 
      { qos: 1 }
    );
    
    console.log('📤 Transaction published to MQTT\n');
    
    // Check if session should continue
    if (state.itemCount >= state.maxItemsPerSession) {
      console.log(`🎉 SESSION COMPLETE! Processed ${state.itemCount} items`);
      console.log('🚪 Closing gate - session ended\n');
      await executeCommand('closeGate');
      state.currentUserId = null;
      state.itemCount = 0;
      state.autoCycleEnabled = false;
    } else {
      console.log(`🔄 Ready for next item (${state.itemCount}/${state.maxItemsPerSession})`);
      
      // Wait before reopening
      await delay(CONFIG.timing.betweenItemsDelay);
      
      // Reopen gate
      await executeCommand('openGate');
      console.log('🚪 Gate reopened - ready for next item\n');
      
      // Restart object detection
      startObjectDetectionWait();
    }
    
    // Reset state
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    
  } catch (error) {
    console.error('\n╔════════════════════════════════════════╗');
    console.error('║      ❌ CYCLE FAILED! ❌              ║');
    console.error('╚════════════════════════════════════════╝');
    console.error('Error:', error.message);
    console.error('════════════════════════════════════════\n');
    
    // Publish failure
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete,
      JSON.stringify({
        sessionId: state.sessionId,
        deviceId: CONFIG.device.id,
        userId: state.currentUserId,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { qos: 1 }
    );
    
    // Emergency stop
    await emergencyStop();
    
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
  }
}

async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP...');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { 
      position: CONFIG.motors.stepper.positions.home 
    });
    await executeCommand('closeGate');
    console.log('✅ Emergency stop complete\n');
  } catch (stopError) {
    console.error('❌ Emergency stop failed:', stopError.message);
  }
}

// ======= WEBSOCKET =======
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      // AI Photo result
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        state.aiResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI Result: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
        
        mqttClient.publish(
          CONFIG.mqtt.topics.aiResult,
          JSON.stringify(state.aiResult)
        );
        
        // If waiting and valid material detected
        if (state.waitingForObject && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Material accepted - getting weight...\n');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low, waiting for better detection...\n`);
          }
        }
        return;
      }
      
      // Weight result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: coefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️  Weight Result: ${state.weight.weight}g`);
        
        mqttClient.publish(
          CONFIG.mqtt.topics.weightResult,
          JSON.stringify(state.weight)
        );
        
        // Calibrate if needed
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${state.calibrationAttempts}/2)...\n`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        // Start cycle if ready
        if (state.waitingForObject && 
            state.aiResult && 
            state.weight.weight > 1 && 
            !state.cycleInProgress) {
          console.log('✅ All checks passed - starting cycle...\n');
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Object detection
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && state.waitingForObject && !state.cycleInProgress) {
          console.log('👁️  OBJECT DETECTED by sensor!');
          console.log('📸 Taking photo for AI analysis...\n');
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ WebSocket error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
}

// ======= MQTT =======
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'online',
      timestamp: new Date().toISOString()
    }),
    { retain: true }
  );
  
  connectWebSocket();
  
  setTimeout(() => {
    requestModuleId();
    setupQRScanner();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto mode: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
    }
    
    if (topic === CONFIG.mqtt.topics.commands && state.moduleId) {
      console.log(`📩 Command received: ${payload.action}`);
      await executeCommand(payload.action, payload.params);
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

// ======= MODULE ID =======
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

// ======= SHUTDOWN =======
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down...');
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'offline',
      timestamp: new Date().toISOString()
    }),
    { retain: true }
  );
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('╔════════════════════════════════════════╗');
console.log('║  RVM AGENT v9.1 - FULLY AUTOMATED     ║');
console.log('╚════════════════════════════════════════╝');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('════════════════════════════════════════');
console.log('🎯 AUTOMATED WORKFLOW:');
console.log('   1. User scans QR code');
console.log('   2. ✨ Gate opens automatically');
console.log('   3. ✨ System waits for object');
console.log('   4. ✨ AI detects + weighs');
console.log('   5. ✨ Auto-process + crush');
console.log('   6. ✨ Gate reopens for next item');
console.log('   7. ✨ Repeat up to 10 items');
console.log('════════════════════════════════════════');
console.log('⏳ Starting system...\n');