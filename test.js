// RVM Agent v9.0 - FULLY AUTOMATED WITH QR & BACKEND VALIDATION
// Save as: agent-v9.0-full-auto-fixed.js

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
  
  // Backend API Configuration
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
    timeout: 10000
  },
  
  // Local Hardware API
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 10000
  },
  
  // MQTT Configuration
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
  
  // QR Scanner Configuration
  qr: {
    scanThreshold: 50,
    minLength: 8,
    maxLength: 20,
    numericOnly: true,
    sessionTimeout: 30000
  },
  
  // Motor Configuration
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
  
  // Detection Thresholds
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25
  },
  
  // Timing (milliseconds)
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 10000,
    positionSettle: 500,
    gateOperation: 1000,
    objectDetectionWait: 30000, // Wait 30 seconds for object
    betweenItemsDelay: 5000     // 5 seconds between items
  },
  
  // Weight Calibration
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
  
  // QR & Automation state
  qrData: '',
  lastKeyTime: 0,
  qrScanEnabled: true,
  currentUserId: null,
  currentUserData: null,
  waitingForObject: false,
  objectDetectionTimer: null,
  sessionTimer: null,
  itemCount: 0,
  maxItemsPerSession: 10,
  sessionActive: false
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// ======= BACKEND QR VALIDATION =======
async function validateQRWithBackend(sessionCode) {
  const url = `${CONFIG.backend.url}${CONFIG.backend.validateEndpoint}`;
  
  console.log('🔐 VALIDATING QR WITH BACKEND');
  console.log(`   URL: ${url}`);
  console.log(`   Code: ${sessionCode}`);
  
  try {
    const response = await axios.post(
      url,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log(`   Response: ${response.status}`);
    
    if (response.data && response.data.success) {
      console.log('   ✅ VALIDATION SUCCESS!\n');
      return {
        valid: true,
        user: response.data.user || {},
        data: response.data
      };
    } else {
      console.log('   ❌ VALIDATION FAILED');
      console.log(`   Error: ${response.data?.error || 'Unknown'}\n`);
      return { valid: false, error: response.data?.error || 'Invalid QR' };
    }
    
  } catch (error) {
    console.error('   ❌ BACKEND ERROR');
    
    if (error.response) {
      const errorMsg = error.response.data?.error || error.response.statusText;
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Error: ${errorMsg}\n`);
      return { valid: false, error: errorMsg };
    }
    
    console.error(`   ${error.message}\n`);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('   Backend not reachable!');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('   Backend timeout!');
    }
    
    return { valid: false, error: error.message };
  }
}

// ======= FULLY AUTOMATED QR SCANNING =======
function setupQRScanner() {
  console.log('\n========================================');
  console.log('📱 QR SCANNER READY');
  console.log('========================================');
  console.log(`⌨️  Listening for QR codes (${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars)`);
  console.log('🎯 Scan QR code to validate and start automation');
  console.log('========================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', (input) => {
    if (!state.qrScanEnabled) return;
    
    const qrCode = input.trim();
    
    // Validate QR code format
    if (qrCode.length >= CONFIG.qr.minLength && 
        qrCode.length <= CONFIG.qr.maxLength &&
        (/^\d+$/.test(qrCode) || !CONFIG.qr.numericOnly)) {
      
      console.log(`\n📱 QR CODE SCANNED: "${qrCode}"\n`);
      handleQRCode(qrCode);
    } else {
      console.log(`❌ Invalid QR format: "${qrCode}" (Length: ${qrCode.length})`);
    }
  });

  console.log('✅ QR Scanner initialized - ready for automated processing');
}

async function handleQRCode(qrCode) {
  const timestamp = new Date().toISOString();
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🎯 QR CODE VALIDATION STARTED        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`📱 Session Code: ${qrCode}`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
  console.log('════════════════════════════════════════\n');
  
  // STEP 1: Validate with backend
  const validation = await validateQRWithBackend(qrCode);
  
  if (!validation.valid) {
    console.log('╔════════════════════════════════════════╗');
    console.log('║       ❌ INVALID QR CODE! ❌          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`Error: ${validation.error}`);
    console.log('Gate remains CLOSED');
    console.log('════════════════════════════════════════\n');
    return;
  }
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║    ✅ QR VALIDATED! STARTING NOW...   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`👤 User: ${validation.user.name || qrCode}`);
  console.log(`📧 Email: ${validation.user.email || 'N/A'}`);
  console.log(`💰 Points: ${validation.user.currentPoints || 0}`);
  console.log('════════════════════════════════════════\n');
  
  // Verify Module ID
  if (!state.moduleId) {
    console.log('⚠️ Module ID not available, requesting...\n');
    
    for (let i = 0; i < 5; i++) {
      await requestModuleId();
      await delay(1000);
      
      if (state.moduleId) {
        console.log(`✅ Module ID: ${state.moduleId}\n`);
        break;
      }
    }
    
    if (!state.moduleId) {
      console.error('❌ Cannot start - Module ID unavailable');
      console.error('   Check hardware connection\n');
      return;
    }
  }
  
  // STEP 2: Store session info
  state.currentUserId = qrCode;
  state.currentUserData = validation.user;
  state.sessionId = generateSessionId();
  state.sessionActive = true;
  state.autoCycleEnabled = true;
  state.itemCount = 0;
  
  console.log(`✅ Session ID: ${state.sessionId}`);
  console.log('✅ Auto mode enabled\n');
  
  // Publish QR scan event to MQTT
  mqttClient.publish(
    CONFIG.mqtt.topics.qrScan,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      userId: qrCode,
      userData: validation.user,
      timestamp: timestamp,
      sessionId: state.sessionId,
      action: 'session_started'
    }),
    { qos: 1 }
  );
  
  // Send to WebSocket
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const wsMessage = { function: "qrcode", data: qrCode };
    state.ws.send(JSON.stringify(wsMessage));
  }
  
  // 🎯 START FULL AUTOMATION SEQUENCE
  await startFullAutomationSequence();
}

// ======= FULL AUTOMATION SEQUENCE =======
async function startFullAutomationSequence() {
  try {
    console.log('🚀 STARTING FULL AUTOMATION SEQUENCE');
    
    // Step 1: Enable auto mode
    state.autoCycleEnabled = true;
    mqttClient.publish(CONFIG.mqtt.topics.autoControl, JSON.stringify({ enabled: true }));
    
    // Step 2: Reset all motors to ready state
    await resetSystemToReadyState();
    
    // Step 3: Open gate for user
    await executeCommand('openGate');
    console.log('🚪 Gate opened - ready for items');
    
    // Step 4: Start session timeout
    startSessionTimeout();
    
    // Step 5: Start waiting for object detection
    startObjectDetectionWait();
    
  } catch (error) {
    console.error('❌ Automation sequence failed:', error.message);
    await endSession();
  }
}

// ======= SESSION TIMEOUT =======
function startSessionTimeout() {
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
  }
  
  state.sessionTimer = setTimeout(async () => {
    if (state.sessionActive && !state.cycleInProgress) {
      console.log('\n⏰ SESSION TIMEOUT - No items processed');
      console.log('🚪 Closing gate and ending session...\n');
      await endSession();
    }
  }, CONFIG.qr.sessionTimeout);
}

// ======= END SESSION =======
async function endSession() {
  console.log('🔚 Ending session...\n');
  
  state.sessionActive = false;
  state.autoCycleEnabled = false;
  
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
  }
  
  if (state.objectDetectionTimer) {
    clearTimeout(state.objectDetectionTimer);
    state.objectDetectionTimer = null;
  }
  
  try {
    if (state.moduleId) {
      await executeCommand('closeGate');
      console.log('✅ Gate closed\n');
    }
  } catch (error) {
    console.error('❌ Error closing gate:', error.message);
  }
  
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.itemCount = 0;
  state.waitingForObject = false;
  
  console.log('✅ Session ended - Ready for next QR scan\n');
}

async function resetSystemToReadyState() {
  console.log('🔧 Resetting system to ready state...');
  
  try {
    // Stop all motors
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // Reset stepper to home
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(2000);
    
    console.log('✅ System reset complete');
  } catch (error) {
    console.error('❌ System reset failed:', error.message);
  }
}

function startObjectDetectionWait() {
  console.log('⏳ Waiting for object detection (30 seconds)...');
  
  state.waitingForObject = true;
  
  // Set timeout for object detection
  state.objectDetectionTimer = setTimeout(async () => {
    if (state.waitingForObject) {
      console.log('⏰ No object detected within timeout period');
      state.waitingForObject = false;
      
      // Close gate and end session
      await endSession();
    }
  }, CONFIG.timing.objectDetectionWait);
}

// ======= MATERIAL DETECTION =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  
  if (className.includes('易拉罐') || className.includes('metal') || className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } else if (className.includes('pet') || className.includes('plastic') || className.includes('瓶') || className.includes('bottle')) {
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
      apiPayload = { moduleId: CONFIG.motors.stepper.moduleId, id: params.position, type: params.position, deviceType };
      break;
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: params.motorId, type: params.type, deviceType };
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  await axios.post(apiUrl, apiPayload, { timeout: CONFIG.local.timeout, headers: { 'Content-Type': 'application/json' } });
  
  // Small delays for specific actions
  if (action === 'takePhoto') await delay(1500);
  if (action === 'getWeight') await delay(2000);
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
  
  // Clear timers
  if (state.objectDetectionTimer) {
    clearTimeout(state.objectDetectionTimer);
    state.objectDetectionTimer = null;
  }
  
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
  }
  
  console.log('\n========================================');
  console.log('🚀 PROCESSING ITEM');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`👤 User: ${state.currentUserData?.name || state.currentUserId || 'N/A'}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log(`🔢 Item: ${state.itemCount + 1}/${state.maxItemsPerSession}`);
  console.log('========================================\n');
  
  try {
    // Step 1: Close gate during processing
    console.log('▶️ Closing gate for processing...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    // Step 2: Belt to weight position
    console.log('▶️ Moving to weight position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 3: Belt to stepper position
    console.log('▶️ Moving to stepper position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    // Step 4: Stepper dump
    console.log('▶️ Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    // Step 5: Compactor
    console.log('▶️ Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // Step 6: Belt return
    console.log('▶️ Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 7: Stepper reset
    console.log('▶️ Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    state.itemCount++;
    
    console.log('========================================');
    console.log('✅ ITEM PROCESSED SUCCESSFULLY');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log(`🔢 Total items: ${state.itemCount}`);
    console.log('========================================\n');
    
    // Publish transaction data
    const transactionData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId,
      userData: state.currentUserData,
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
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(transactionData), { qos: 1 });
    
    // Check if user can add more items
    if (state.itemCount >= state.maxItemsPerSession) {
      console.log(`🎉 Session complete! Processed ${state.itemCount} items`);
      await endSession();
    } else {
      console.log(`🔄 Ready for next item (${state.itemCount}/${state.maxItemsPerSession})`);
      
      // Reopen gate for next item
      await delay(CONFIG.timing.betweenItemsDelay);
      await executeCommand('openGate');
      console.log('🚪 Gate reopened - ready for next item');
      
      // Restart object detection wait and session timeout
      startObjectDetectionWait();
      startSessionTimeout();
    }
    
    // Reset processing state
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', error.message);
    console.error('========================================\n');
    
    // Publish failure
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify({
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId,
      status: 'failed',
      error: error.message,
      timestamp: new Date().toISOString()
    }), { qos: 1 });
    
    // Emergency stop and reset
    await emergencyStop();
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    await endSession();
  }
}

async function emergencyStop() {
  console.log('🛑 Emergency stop...');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
  } catch (stopError) {
    console.error('❌ Emergency stop failed:', stopError.message);
  }
}

// ======= WEBSOCKET HANDLER =======
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID response
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
        
        console.log(`🤖 AI: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
        
        // Publish AI result
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        // If valid material detected and waiting for object, proceed to weight
        if (state.waitingForObject && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Object detected - proceeding to weight...');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)`);
            // Continue waiting for better detection
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
        
        console.log(`⚖️ Weight: ${state.weight.weight}g`);
        
        // Publish weight result
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        // Calibrate if needed
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${state.calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        // Start cycle if ready
        if (state.waitingForObject && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Object detection (infrared sensor)
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && state.waitingForObject && !state.cycleInProgress) {
          console.log('👤 Object detected by sensor - taking photo...');
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

// ======= MQTT CLIENT =======
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
  
  // Publish online status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      // Handle manual commands if needed
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

// ======= MODULE ID REQUEST =======
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

// ======= GRACEFUL SHUTDOWN =======
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v9.0 - FULLY AUTOMATED');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('========================================');
console.log('🎯 AUTOMATED WORKFLOW:');
console.log('   1. User scans QR code → Backend validation');
console.log('   2. If valid → Gate opens automatically');
console.log('   3. System waits for object (30s timeout)');
console.log('   4. AI detects material + weighs item');
console.log('   5. Auto-processing and crushing');
console.log('   6. Gate reopens for next item');
console.log('   7. Repeat until 10 items or timeout');
console.log('========================================');
console.log('📡 MQTT Topics:');
console.log(`   QR Scan: ${CONFIG.mqtt.topics.qrScan}`);
console.log(`   Cycle Complete: ${CONFIG.mqtt.topics.cycleComplete}`);
console.log('========================================\n');
console.log('⏳ Starting automated system...\n');