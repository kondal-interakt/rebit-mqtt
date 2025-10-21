// ============================================================
// RVM AGENT v9.6 - PRODUCTION READY (HYBRID APPROACH)
// Based on working v9.5 + Module ID validation + Better logging
// ============================================================

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');

// ======= CONFIGURATION =======
const CONFIG = {
  device: {
    id: 'RVM-3101',
    version: '9.6.0'
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
    scanTimeout: 100,
    processDelay: 200
  },
  
  motors: {
    belt: {
      toWeight: { motorId: '02', type: '02' },
      toStepper: { motorId: '02', type: '03' },
      reverse: { motorId: '02', type: '01' },
      stop: { motorId: '02', type: '00' }
    },
    compactor: {
      start: { motorId: '04', type: '01' },
      stop: { motorId: '04', type: '00' }
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
    autoPhotoDelay: 5000,
    moduleIdWait: 10000  // Wait up to 10 seconds for Module ID
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ======= STATE =======
const state = {
  moduleId: null,
  moduleIdReady: false,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  sessionId: null,
  qrScanEnabled: false,  // Disabled until Module ID received
  currentUserId: null,
  currentUserData: null,
  autoPhotoTimer: null,
  isProcessingQR: false
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: '📋',
    success: '✅',
    error: '❌',
    warn: '⚠️',
    debug: '🔍'
  }[type] || '📋';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ======= BACKEND QR VALIDATION =======
async function validateQRWithBackend(sessionCode) {
  const url = `${CONFIG.backend.url}${CONFIG.backend.validateEndpoint}`;
  
  log('═══════════════════════════════════════', 'info');
  log('🔐 VALIDATING QR WITH BACKEND', 'info');
  log(`   URL: ${url}`, 'info');
  log(`   Code: ${sessionCode}`, 'info');
  log('═══════════════════════════════════════', 'info');
  
  try {
    const response = await axios.post(
      url,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    log(`   Response Status: ${response.status}`, 'info');
    log(`   Response Data: ${JSON.stringify(response.data)}`, 'debug');
    
    if (response.data && response.data.success) {
      log('   ✅ VALIDATION SUCCESS!', 'success');
      return {
        valid: true,
        user: response.data.user || {},
        data: response.data
      };
    } else {
      log('   ❌ VALIDATION FAILED', 'error');
      log(`   Error: ${response.data?.error || 'Unknown'}`, 'error');
      return { valid: false, error: response.data?.error || 'Invalid QR' };
    }
    
  } catch (error) {
    log('   ❌ BACKEND ERROR', 'error');
    
    if (error.response) {
      const errorMsg = error.response.data?.error || error.response.statusText;
      log(`   Status: ${error.response.status}`, 'error');
      log(`   Error: ${errorMsg}`, 'error');
      return { valid: false, error: errorMsg };
    }
    
    log(`   ${error.message}`, 'error');
    return { valid: false, error: error.message };
  }
}

// ======= QR SCANNER =======
let qrBuffer = '';
let lastCharTime = 0;
let qrScanTimer = null;

function setupQRScanner() {
  log('═══════════════════════════════════════', 'info');
  log('📱 QR SCANNER INITIALIZING', 'info');
  log(`   Length: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars`, 'info');
  log(`   Timeout: ${CONFIG.qr.scanTimeout}ms between chars`, 'info');
  log(`   Process delay: ${CONFIG.qr.processDelay}ms`, 'info');
  log('   ⚠️  WAITING FOR MODULE ID...', 'warn');
  log('═══════════════════════════════════════', 'info');

  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  process.stdin.on('data', handleQRInput);
  
  process.stdin.on('error', (error) => {
    log(`STDIN error: ${error.message}`, 'error');
    setTimeout(() => process.stdin.resume(), 1000);
  });
}

function handleQRInput(chunk) {
  // Handle Ctrl+C
  if (chunk === '\u0003') {
    gracefulShutdown();
    return;
  }

  const now = Date.now();
  const data = chunk.toString();

  // Check for Enter key (end of scan)
  if (data.includes('\r') || data.includes('\n')) {
    log('Enter key detected', 'debug');
    processScan();
    return;
  }

  // Reset buffer if timeout exceeded (new scan)
  if (now - lastCharTime > CONFIG.qr.scanTimeout) {
    if (qrBuffer.length > 0) {
      log('Timeout - processing previous scan', 'debug');
      processScan();
    }
    qrBuffer = '';
  }

  // Add characters to buffer
  const cleanData = data.replace(/[\r\n\u0000-\u001F\u007F]/g, '');
  if (cleanData.length > 0) {
    qrBuffer += cleanData;
    lastCharTime = now;

    // Show progress
    process.stdout.write(`\r📥 Scanning: ${qrBuffer}... (${qrBuffer.length} chars)`);

    // Auto-process after reaching max length
    if (qrBuffer.length >= CONFIG.qr.maxLength) {
      console.log('');
      log('Max length reached - processing', 'info');
      processScan();
      return;
    }

    // Auto-process timer
    if (qrScanTimer) clearTimeout(qrScanTimer);
    
    if (qrBuffer.length >= CONFIG.qr.minLength) {
      qrScanTimer = setTimeout(() => {
        console.log('');
        log('Auto-processing (timeout)', 'info');
        processScan();
      }, CONFIG.qr.processDelay);
    }
  }
}

function processScan() {
  if (qrScanTimer) {
    clearTimeout(qrScanTimer);
    qrScanTimer = null;
  }

  const code = qrBuffer.trim();
  qrBuffer = '';

  if (code.length === 0) return;

  console.log('');
  log(`QR Scanned: "${code}" (${code.length} chars)`, 'info');

  // CRITICAL: Check Module ID
  if (!state.moduleId || !state.moduleIdReady) {
    log('❌ CANNOT PROCESS - MODULE ID NOT READY!', 'error');
    log('⏳ Please wait for system initialization...', 'warn');
    log(`   Module ID: ${state.moduleId || 'NOT RECEIVED'}`, 'info');
    log(`   Ready: ${state.moduleIdReady}`, 'info');
    return;
  }

  // Validate format
  if (code.length < CONFIG.qr.minLength || code.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${code.length}`, 'error');
    return;
  }

  if (CONFIG.qr.numericOnly && !/^\d+$/.test(code)) {
    log('Invalid QR format: must be numeric', 'error');
    return;
  }

  if (state.isProcessingQR) {
    log('Already processing QR - ignoring', 'warn');
    return;
  }

  if (!state.qrScanEnabled) {
    log('QR scanning disabled - session active', 'warn');
    return;
  }

  log('✅ Valid QR - processing now...', 'success');
  handleQRCode(code).catch(error => {
    log(`QR processing error: ${error.message}`, 'error');
    resetQRState();
  });
}

function resetQRState() {
  log('Resetting QR state', 'debug');
  state.isProcessingQR = false;
  state.qrScanEnabled = state.moduleIdReady; // Only enable if Module ID ready
  qrBuffer = '';
  if (qrScanTimer) {
    clearTimeout(qrScanTimer);
    qrScanTimer = null;
  }
}

// ======= QR HANDLER =======
async function handleQRCode(qrCode) {
  if (state.isProcessingQR) {
    log('Already processing QR', 'warn');
    return;
  }
  
  state.isProcessingQR = true;
  
  log('═══════════════════════════════════════', 'info');
  log('🎯 QR CODE VALIDATION STARTED', 'info');
  log(`   Code: ${qrCode}`, 'info');
  log(`   Module ID: ${state.moduleId}`, 'info');
  log(`   Time: ${new Date().toLocaleTimeString()}`, 'info');
  log('═══════════════════════════════════════', 'info');
  
  try {
    // Validate with backend
    const validation = await validateQRWithBackend(qrCode);
    
    if (!validation.valid) {
      log('═══════════════════════════════════════', 'error');
      log('❌ INVALID QR CODE', 'error');
      log(`   Error: ${validation.error}`, 'error');
      log('   Gate remains CLOSED', 'info');
      log('═══════════════════════════════════════', 'error');
      resetQRState();
      return;
    }
    
    log('═══════════════════════════════════════', 'success');
    log('✅ QR VALIDATED - STARTING SESSION', 'success');
    log(`   User: ${validation.user.name || qrCode}`, 'info');
    log(`   Email: ${validation.user.email || 'N/A'}`, 'info');
    log(`   Points: ${validation.user.currentPoints || 0}`, 'info');
    log('═══════════════════════════════════════', 'success');
    
    // Store session
    state.currentUserId = qrCode;
    state.currentUserData = validation.user;
    state.sessionId = generateSessionId();
    
    log(`Session ID: ${state.sessionId}`, 'info');
    
    // Publish QR scan event
    mqttClient.publish(
      CONFIG.mqtt.topics.qrScan,
      JSON.stringify({
        deviceId: CONFIG.device.id,
        userId: qrCode,
        userData: validation.user,
        timestamp: new Date().toISOString(),
        sessionId: state.sessionId
      }),
      { qos: 1 }
    );
    
    // Start automation
    await startAutomation();
    
  } catch (error) {
    log(`QR handling failed: ${error.message}`, 'error');
    console.error(error.stack);
    resetQRState();
  }
}

// ======= AUTOMATION =======
async function startAutomation() {
  try {
    log('🚀 STARTING AUTOMATION SEQUENCE', 'info');
    
    state.qrScanEnabled = false;
    state.autoCycleEnabled = true;
    
    mqttClient.publish(CONFIG.mqtt.topics.autoControl, JSON.stringify({ enabled: true }));
    log('Auto mode enabled', 'success');
    
    log('Resetting motors...', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(2000);
    log('Motors reset complete', 'success');
    
    log('Opening gate...', 'info');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    log('Gate opened - Ready for items!', 'success');
    
    log('Waiting for object detection...', 'info');
    log('Auto photo in 5 seconds if no detection', 'info');
    
    // Auto photo timer
    state.autoPhotoTimer = setTimeout(async () => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.aiResult) {
        log('Auto photo triggered', 'info');
        await executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
  } catch (error) {
    log(`Automation failed: ${error.message}`, 'error');
    resetQRState();
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
    log(`${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`, 'warn');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`${materialType} detected (${confidencePercent}%)`, 'success');
  }
  
  return materialType;
}

// ======= HARDWARE COMMANDS =======
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  
  if (!state.moduleId) {
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
    case 'getModuleId':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getModuleId`;
      apiPayload = {};
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  log(`Executing: ${action}`, 'debug');
  await axios.post(apiUrl, apiPayload, { 
    timeout: CONFIG.local.timeout, 
    headers: { 'Content-Type': 'application/json' } 
  });
  
  if (action === 'takePhoto') await delay(1500);
  if (action === 'getWeight') await delay(2000);
}

// ======= CYCLE =======
async function executeAutoCycle() {
  const cycleStartTime = Date.now();
  
  log('═══════════════════════════════════════', 'info');
  log('🚀 PROCESSING ITEM', 'info');
  log(`   Session: ${state.sessionId}`, 'info');
  log(`   User: ${state.currentUserData?.name || state.currentUserId}`, 'info');
  log(`   Material: ${state.aiResult.materialType}`, 'info');
  log(`   Confidence: ${state.aiResult.matchRate}%`, 'info');
  log(`   Weight: ${state.weight.weight}g`, 'info');
  log('═══════════════════════════════════════', 'info');
  
  try {
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    log('Step 1/8: Closing gate', 'info');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    log('Step 2/8: Moving to weight position', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    log('Step 3/8: Moving to stepper position', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    log('Step 4/8: Dumping to crusher', 'info');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    log('Step 5/8: Crushing', 'info');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    log('Step 6/8: Returning belt', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    log('Step 7/8: Resetting stepper', 'info');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    log(`Step 8/8: Cycle complete (${cycleTime}s)`, 'success');
    
    // Publish transaction
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete, 
      JSON.stringify({
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
      }), 
      { qos: 1 }
    );
    
    log('Transaction published', 'success');
    
  } catch (error) {
    log(`Cycle failed: ${error.message}`, 'error');
    await emergencyStop();
    
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
  } finally {
    // ALWAYS reset
    state.cycleInProgress = false;
    state.autoCycleEnabled = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    
    resetQRState();
    
    log('═══════════════════════════════════════', 'success');
    log('✅ READY FOR NEXT QR SCAN', 'success');
    log('═══════════════════════════════════════', 'success');
  }
}

async function emergencyStop() {
  log('Emergency stop', 'warn');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
  } catch (error) {
    log(`Emergency stop failed: ${error.message}`, 'error');
  }
}

// ======= WEBSOCKET =======
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('WebSocket connected', 'success');
    // Request Module ID immediately
    setTimeout(() => requestModuleId(), 500);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID response - CRITICAL!
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        state.moduleIdReady = true;
        state.qrScanEnabled = true;
        
        log('═══════════════════════════════════════', 'success');
        log(`✅ MODULE ID RECEIVED: ${state.moduleId}`, 'success');
        log('✅ SYSTEM NOW READY FOR QR SCANS', 'success');
        log('═══════════════════════════════════════', 'success');
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
        
        log(`AI Result: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`, 'info');
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            log('Proceeding to weight', 'success');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            log(`Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)`, 'warn');
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
        
        log(`Weight: ${state.weight.weight}g`, 'info');
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          log(`Calibrating weight (${state.calibrationAttempts}/2)`, 'warn');
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
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          log('Object detected - taking photo', 'info');
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      log(`WebSocket error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('close', () => {
    log('WebSocket closed - reconnecting...', 'warn');
    state.moduleIdReady = false;
    state.qrScanEnabled = false;
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    log(`WebSocket error: ${error.message}`, 'error');
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
  log('MQTT connected', 'success');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    version: CONFIG.device.version,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  // Connect WebSocket and wait for Module ID
  connectWebSocket();
  
  // Start QR scanner (will wait for Module ID)
  setTimeout(() => setupQRScanner(), 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      log(`Auto mode: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`, 'info');
      
      if (state.moduleId) {
        if (state.autoCycleEnabled) {
          await executeCommand('openGate');
        } else {
          await executeCommand('closeGate');
        }
      }
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      log(`MQTT command: ${payload.action}`, 'info');
      
      if (payload.action === 'takePhoto' && state.moduleId) {
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
          log(`Manual override: ${payload.materialType}`, 'info');
          
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
    log(`MQTT error: ${error.message}`, 'error');
  }
});

async function requestModuleId() {
  try {
    log('Requesting Module ID...', 'info');
    await executeCommand('getModuleId');
  } catch (error) {
    log(`Module ID request failed: ${error.message}`, 'error');
  }
}

function gracefulShutdown() {
  log('Shutting down...', 'warn');
  
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
process.on('SIGTERM', gracefulShutdown);

// ======= STARTUP =======
log('═══════════════════════════════════════', 'info');
log('🚀 RVM AGENT v9.6 STARTING', 'info');
log('═══════════════════════════════════════', 'info');
log(`Device: ${CONFIG.device.id}`, 'info');
log(`Version: ${CONFIG.device.version}`, 'info');
log(`Backend: ${CONFIG.backend.url}`, 'info');
log('═══════════════════════════════════════', 'info');
log('Features:', 'info');
log('  ✅ Module ID validation', 'info');
log('  ✅ Permanent QR scanning', 'info');
log('  ✅ Auto photo fallback', 'info');
log('  ✅ Complete logging', 'info');
log('  ✅ Zero-downtime operation', 'info');
log('═══════════════════════════════════════', 'info');
log('Starting...', 'info');