// RVM Agent v9.5 - FIXED QR SCANNER
// Key fixes: Enter key detection, better buffer management, proper error recovery

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
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
    timeout: 10000
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
    maxLength: 20,
    numericOnly: true,
    scanThreshold: 100,  // Time gap to detect new scan (ms)
    scanTimeout: 3000    // Maximum time to wait for complete scan
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
    positionSettle: 500,
    gateOperation: 1000,
    autoPhotoDelay: 5000
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
  
  // QR specific
  qrScanEnabled: true,
  currentUserId: null,
  currentUserData: null,
  qrScanTimer: null,
  qrTimeoutTimer: null,
  autoPhotoTimer: null,
  qrBuffer: '',
  lastKeyTime: 0,
  isProcessingQR: false
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// Clear QR state completely
function clearQRState() {
  state.qrBuffer = '';
  state.lastKeyTime = 0;
  if (state.qrScanTimer) {
    clearTimeout(state.qrScanTimer);
    state.qrScanTimer = null;
  }
  if (state.qrTimeoutTimer) {
    clearTimeout(state.qrTimeoutTimer);
    state.qrTimeoutTimer = null;
  }
}

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
    return { valid: false, error: error.message };
  }
}

// ======= IMPROVED QR SCANNER =======
function setupQRScanner() {
  console.log('\n========================================');
  console.log('📱 FIXED QR SCANNER - ALWAYS ACTIVE');
  console.log('========================================');
  console.log(`⌨️  Listening for QR codes (${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars)`);
  console.log('🎯 Scanner detects Enter key automatically');
  console.log('🔄 Automatic error recovery enabled');
  console.log('========================================\n');

  setupStdinScanner();
  
  console.log('✅ QR Scanner initialized - Ready to scan!');
}

function setupStdinScanner() {
  process.stdin.setEncoding('utf8');
  
  // Use readline interface for better keyboard input handling
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  // Buffer for accumulating characters
  let scanBuffer = '';
  let lastCharTime = Date.now();

  process.stdin.on('data', (chunk) => {
    const now = Date.now();
    const str = chunk.toString();
    
    // Check for Ctrl+C
    if (str === '\u0003') {
      gracefulShutdown();
      return;
    }
    
    // If too much time passed, this is a new scan
    if (now - lastCharTime > CONFIG.qr.scanThreshold) {
      scanBuffer = '';
    }
    
    lastCharTime = now;
    
    // Process each character
    for (let char of str) {
      // Check for Enter key (various formats)
      if (char === '\n' || char === '\r' || char === '\u000D' || char === '\u000A') {
        if (scanBuffer.length > 0) {
          handleCompleteScan(scanBuffer.trim());
          scanBuffer = '';
        }
        continue;
      }
      
      // Skip non-alphanumeric in numeric-only mode
      if (CONFIG.qr.numericOnly && !/[\d]/.test(char)) {
        continue;
      }
      
      // Add character to buffer
      scanBuffer += char;
      
      // Start timeout timer
      clearTimeout(state.qrTimeoutTimer);
      state.qrTimeoutTimer = setTimeout(() => {
        if (scanBuffer.length >= CONFIG.qr.minLength) {
          console.log('⏰ Scan timeout - processing accumulated data');
          handleCompleteScan(scanBuffer.trim());
          scanBuffer = '';
        } else if (scanBuffer.length > 0) {
          console.log(`❌ Incomplete scan timeout (${scanBuffer.length} chars) - discarding`);
          scanBuffer = '';
        }
      }, CONFIG.qr.scanTimeout);
    }
  });

  process.stdin.on('error', (error) => {
    console.error('❌ STDIN error:', error.message);
    console.log('🔄 Attempting recovery in 1 second...');
    setTimeout(() => {
      try {
        process.stdin.resume();
        console.log('✅ STDIN recovered');
      } catch (e) {
        console.error('❌ Recovery failed:', e.message);
      }
    }, 1000);
  });

  // Keep stdin open
  process.stdin.resume();
}

function handleCompleteScan(qrData) {
  const qrCode = qrData.trim();
  
  console.log(`\n📱 RAW SCAN DATA: "${qrCode}" (${qrCode.length} chars)`);
  
  // Validate QR format
  if (qrCode.length < CONFIG.qr.minLength || qrCode.length > CONFIG.qr.maxLength) {
    console.log(`❌ Invalid length: Expected ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} characters\n`);
    return;
  }
  
  if (CONFIG.qr.numericOnly && !/^\d+$/.test(qrCode)) {
    console.log(`❌ Invalid format: Expected numeric only\n`);
    return;
  }
  
  console.log(`✅ Valid QR detected: "${qrCode}"`);
  
  // Check if we can process
  if (!state.qrScanEnabled) {
    console.log('⏳ QR scanning disabled - session in progress\n');
    return;
  }
  
  if (state.isProcessingQR) {
    console.log('⏳ Already processing QR - please wait\n');
    return;
  }
  
  // Process the QR code
  handleQRCode(qrCode).catch(error => {
    console.error('❌ QR processing error:', error.message);
    // CRITICAL: Reset flags on error
    resetQRFlags();
  });
}

function resetQRFlags() {
  state.isProcessingQR = false;
  state.qrScanEnabled = true;
  clearQRState();
  console.log('🔄 QR scanner reset - ready for next scan\n');
}

async function handleQRCode(qrCode) {
  if (state.isProcessingQR) {
    console.log('⏳ Already processing QR, please wait...');
    return;
  }
  
  state.isProcessingQR = true;
  const timestamp = new Date().toISOString();
  
  try {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   🎯 QR CODE VALIDATION STARTED        ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`📱 Session Code: ${qrCode}`);
    console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
    console.log('════════════════════════════════════════\n');
    
    // VALIDATE WITH BACKEND
    const validation = await validateQRWithBackend(qrCode);
    
    if (!validation.valid) {
      console.log('╔════════════════════════════════════════╗');
      console.log('║       ❌ INVALID QR CODE! ❌          ║');
      console.log('╚════════════════════════════════════════╝');
      console.log(`Error: ${validation.error}`);
      console.log('Gate remains CLOSED');
      console.log('════════════════════════════════════════\n');
      
      // Re-enable QR scanning
      resetQRFlags();
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
        console.error('❌ Cannot start - Module ID unavailable\n');
        resetQRFlags();
        return;
      }
    }
    
    // Store session info
    state.currentUserId = qrCode;
    state.currentUserData = validation.user;
    state.sessionId = generateSessionId();
    
    console.log(`✅ Session ID: ${state.sessionId}\n`);
    
    // Publish QR scan event
    mqttClient.publish(
      CONFIG.mqtt.topics.qrScan,
      JSON.stringify({
        deviceId: CONFIG.device.id,
        userId: qrCode,
        userData: validation.user,
        timestamp: timestamp,
        sessionId: state.sessionId
      }),
      { qos: 1 }
    );
    
    // START AUTOMATION
    await startAutomation();
    
  } catch (error) {
    console.error('❌ QR handling error:', error.message);
    resetQRFlags();
  }
}

// ======= START AUTOMATION =======
async function startAutomation() {
  try {
    console.log('🚀 STARTING AUTOMATION SEQUENCE\n');
    
    // Temporarily disable QR scanning during automation
    state.qrScanEnabled = false;
    
    // Step 1: Enable auto mode
    state.autoCycleEnabled = true;
    mqttClient.publish(CONFIG.mqtt.topics.autoControl, JSON.stringify({ enabled: true }));
    console.log('✅ Auto mode enabled\n');
    
    // Step 2: Reset motors
    console.log('🔧 Resetting system...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(2000);
    console.log('✅ System reset complete\n');
    
    // Step 3: Open gate
    console.log('🚪 Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate opened - Ready for items!\n');
    
    console.log('👁️  Waiting for object detection...');
    console.log('⏰ Auto photo in 5 seconds if no detection...\n');
    
    // AUTO PHOTO TIMER
    state.autoPhotoTimer = setTimeout(async () => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.aiResult) {
        console.log('⏰ AUTO PHOTO TRIGGERED - Taking photo now...\n');
        await executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
  } catch (error) {
    console.error('❌ Automation failed:', error.message);
    resetQRFlags();
  }
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
  
  console.log(`🔧 Executing: ${action}`, params);
  await axios.post(apiUrl, apiPayload, { timeout: CONFIG.local.timeout, headers: { 'Content-Type': 'application/json' } });
  
  if (action === 'takePhoto') await delay(1500);
  if (action === 'getWeight') await delay(2000);
}

// ======= AUTO CYCLE =======
async function executeAutoCycle() {
  const cycleStartTime = Date.now();
  
  console.log('\n========================================');
  console.log('🚀 PROCESSING ITEM');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`👤 User: ${state.currentUserData?.name || state.currentUserId || 'N/A'}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');
  
  try {
    // Clear auto photo timer
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    console.log('▶️ Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    console.log('▶️ Moving to weight position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️ Moving to stepper position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    console.log('▶️ Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    console.log('▶️ Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    console.log('▶️ Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️ Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    
    console.log('========================================');
    console.log('✅ ITEM PROCESSED SUCCESSFULLY');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log('========================================\n');
    
    // Publish transaction
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
      timestamp: new Date().toISOString(),
      status: 'success'
    };
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(transactionData), { qos: 1 });
    console.log('📤 Transaction published to MQTT\n');
    
    // RESET FOR NEXT SCAN
    state.cycleInProgress = false;
    state.autoCycleEnabled = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    
    // RE-ENABLE QR SCANNER
    resetQRFlags();
    
    console.log('🔄 QR SCANNER RE-ACTIVATED - Ready for next user!');
    console.log('📱 Scan next QR code anytime...\n');
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', error.message);
    console.error('========================================\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify({
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId,
      status: 'failed',
      error: error.message,
      timestamp: new Date().toISOString()
    }), { qos: 1 });
    
    await emergencyStop();
    state.cycleInProgress = false;
    
    // RE-ENABLE ON FAILURE TOO
    resetQRFlags();
  }
}

async function emergencyStop() {
  console.log('🛑 Emergency stop...');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
  } catch (error) {
    console.error('❌ Emergency stop failed:', error.message);
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
      console.log(`📡 WebSocket message: ${message.function}`, message.data);
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      // AI Photo result
      if (message.function === 'aiPhoto') {
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        
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
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...\n');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
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
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
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
        
        if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Object detection
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        console.log(`🔍 DEVICE STATUS: code=${code}`);
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          console.log('👤 OBJECT DETECTED BY SENSOR - TAKING PHOTO!\n');
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
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
      
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
      }
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO CAPTURE TRIGGERED!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await executeCommand('takePhoto');
        return;
      }
      
      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          state.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL_OVERRIDE',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`🔧 Manual override: ${payload.materialType}`);
          
          if (state.autoCycleEnabled) {
            setTimeout(() => executeCommand('getWeight'), 500);
          }
        }
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

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

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  
  // Clear all timers
  clearQRState();
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  
  process.stdin.pause();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error.message);
  console.log('🔄 Attempting to recover QR scanner...');
  resetQRFlags();
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v9.5 - FIXED QR SCANNER');
console.log('🔄 ENTER KEY DETECTION + AUTO RECOVERY');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('========================================');
console.log('🎯 KEY FIXES:');
console.log('   ✅ Enter key detection (primary)');
console.log('   ✅ Timeout fallback (3 seconds)');
console.log('   ✅ Buffer cleared on ALL errors');
console.log('   ✅ Flags reset automatically');
console.log('   ✅ Uncaught exception handling');
console.log('========================================');
console.log('⏳ Starting system...\n');