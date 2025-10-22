// RVM Agent v9.6 - WEB FRONTEND INTEGRATION
// Save as: agent-v9.6-frontend-integration.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');
const http = require('http');

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
  
  // WebSocket Server for Frontend
  frontend: {
    port: 8082,
    path: '/agent'
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
    autoPhotoDelay: 5000
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
  ws: null, // Hardware WebSocket
  frontendWs: null, // Frontend WebSocket
  sessionId: null,
  
  // QR specific
  qrScanEnabled: true,
  currentUserId: null,
  currentUserData: null,
  qrScanTimer: null,
  autoPhotoTimer: null,
  isProcessingQR: false
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
    return { valid: false, error: error.message };
  }
}

// ======= FRONTEND WEBSOCKET SERVER =======
function setupFrontendWebSocketServer() {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  
  wss.on('connection', (ws) => {
    console.log('✅ Frontend WebSocket connected');
    state.frontendWs = ws;
    
    // Send connection confirmation
    sendToFrontend({
      type: 'agent_connected',
      status: 'connected',
      deviceId: CONFIG.device.id,
      timestamp: new Date().toISOString()
    });
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        console.log('📱 Frontend message received:', message);
        
        // Handle QR validation from frontend
        if (message.type === 'qr_validated' && message.startAutoCycle) {
          console.log('🚀 Frontend QR validated - Starting automation');
          await handleFrontendQRCode(message);
        }
        
        // Handle other frontend commands
        if (message.type === 'manual_operation') {
          console.log('🔧 Manual operation requested:', message.action);
          await handleManualOperation(message);
        }
        
      } catch (error) {
        console.error('❌ Frontend message error:', error.message);
      }
    });
    
    ws.on('close', () => {
      console.log('⚠️ Frontend WebSocket disconnected');
      state.frontendWs = null;
    });
    
    ws.on('error', (error) => {
      console.error('❌ Frontend WebSocket error:', error.message);
      state.frontendWs = null;
    });
  });
  
  server.listen(CONFIG.frontend.port, () => {
    console.log(`✅ Frontend WebSocket server running on port ${CONFIG.frontend.port}`);
    console.log(`   Frontend can connect to: ws://localhost:${CONFIG.frontend.port}${CONFIG.frontend.path}`);
  });
  
  return wss;
}

// ======= FRONTEND COMMUNICATION =======
function sendToFrontend(data) {
  if (state.frontendWs && state.frontendWs.readyState === WebSocket.OPEN) {
    state.frontendWs.send(JSON.stringify(data));
    console.log('📤 Sent to frontend:', data.type);
    return true;
  } else {
    console.warn('⚠️ Frontend not connected, cannot send data');
    return false;
  }
}

// ======= HANDLE FRONTEND QR CODE =======
async function handleFrontendQRCode(message) {
  if (state.isProcessingQR) {
    console.log('⏳ Already processing QR, please wait...');
    sendToFrontend({
      type: 'agent_busy',
      message: 'Agent is currently processing another QR code',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  state.isProcessingQR = true;
  const { sessionCode, userId, userName, userEmail } = message;
  
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🎯 FRONTEND QR CODE RECEIVED        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`📱 Session Code: ${sessionCode}`);
  console.log(`👤 User: ${userName}`);
  console.log(`📧 Email: ${userEmail}`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
  console.log('════════════════════════════════════════\n');
  
  // Notify frontend
  sendToFrontend({
    type: 'automation_starting',
    message: 'Starting RVM automation sequence',
    sessionCode: sessionCode,
    timestamp: new Date().toISOString()
  });
  
  // Verify Module ID
  if (!state.moduleId) {
    console.log('⚠️ Module ID not available, requesting...\n');
    sendToFrontend({
      type: 'status_update',
      status: 'initializing',
      message: 'Getting module ID from hardware',
      timestamp: new Date().toISOString()
    });
    
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
      sendToFrontend({
        type: 'error',
        message: 'Hardware module not available',
        timestamp: new Date().toISOString()
      });
      state.isProcessingQR = false;
      return;
    }
  }
  
  // Store session info
  state.currentUserId = sessionCode;
  state.currentUserData = {
    id: userId,
    name: userName,
    email: userEmail
  };
  state.sessionId = generateSessionId();
  
  console.log(`✅ Session ID: ${state.sessionId}\n`);
  
  // Publish QR scan event to MQTT
  mqttClient.publish(
    CONFIG.mqtt.topics.qrScan,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      userId: sessionCode,
      userData: state.currentUserData,
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      source: 'frontend'
    }),
    { qos: 1 }
  );
  
  // START AUTOMATION
  await startAutomation();
}

// ======= START AUTOMATION =======
async function startAutomation() {
  try {
    console.log('🚀 STARTING AUTOMATION SEQUENCE\n');
    
    sendToFrontend({
      type: 'status_update',
      status: 'starting',
      message: 'Starting automation sequence',
      timestamp: new Date().toISOString()
    });
    
    // Step 1: Enable auto mode
    state.autoCycleEnabled = true;
    mqttClient.publish(CONFIG.mqtt.topics.autoControl, JSON.stringify({ enabled: true }));
    console.log('✅ Auto mode enabled\n');
    
    sendToFrontend({
      type: 'status_update',
      status: 'resetting',
      message: 'Resetting system motors',
      timestamp: new Date().toISOString()
    });
    
    // Step 2: Reset motors
    console.log('🔧 Resetting system...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(2000);
    console.log('✅ System reset complete\n');
    
    sendToFrontend({
      type: 'status_update',
      status: 'opening_gate',
      message: 'Opening gate for item placement',
      timestamp: new Date().toISOString()
    });
    
    // Step 3: Open gate
    console.log('🚪 Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate opened - Ready for items!\n');
    
    sendToFrontend({
      type: 'status_update',
      status: 'waiting_item',
      message: 'Gate opened - Please place your item',
      timestamp: new Date().toISOString()
    });
    
    console.log('👁️  Waiting for object detection...');
    console.log('⏰ Auto photo in 5 seconds if no detection...\n');
    
    // AUTO PHOTO TIMER
    state.autoPhotoTimer = setTimeout(async () => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.aiResult) {
        console.log('⏰ AUTO PHOTO TRIGGERED - Taking photo now...\n');
        sendToFrontend({
          type: 'status_update',
          status: 'taking_photo',
          message: 'Auto photo triggered - Detecting item',
          timestamp: new Date().toISOString()
        });
        await executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
  } catch (error) {
    console.error('❌ Automation failed:', error.message);
    sendToFrontend({
      type: 'error',
      message: `Automation failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });
    resetSystemForNextUser();
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
  
  sendToFrontend({
    type: 'cycle_start',
    message: 'Starting item processing cycle',
    materialType: state.aiResult.materialType,
    confidence: state.aiResult.matchRate,
    timestamp: new Date().toISOString()
  });
  
  try {
    // Clear auto photo timer
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    console.log('▶️ Closing gate...');
    sendToFrontend({
      type: 'status_update',
      status: 'closing_gate',
      message: 'Closing gate for processing',
      timestamp: new Date().toISOString()
    });
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    console.log('▶️ Moving to weight position...');
    sendToFrontend({
      type: 'status_update',
      status: 'moving_to_weight',
      message: 'Moving item to weight station',
      timestamp: new Date().toISOString()
    });
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️ Moving to stepper position...');
    sendToFrontend({
      type: 'status_update',
      status: 'moving_to_sorter',
      message: 'Moving item to sorting station',
      timestamp: new Date().toISOString()
    });
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    console.log('▶️ Dumping to crusher...');
    sendToFrontend({
      type: 'status_update',
      status: 'sorting_item',
      message: 'Sorting item to appropriate bin',
      timestamp: new Date().toISOString()
    });
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    console.log('▶️ Crushing...');
    sendToFrontend({
      type: 'status_update',
      status: 'crushing',
      message: 'Crushing and compacting item',
      timestamp: new Date().toISOString()
    });
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    console.log('▶️ Returning belt...');
    sendToFrontend({
      type: 'status_update',
      status: 'returning',
      message: 'Returning conveyor belt',
      timestamp: new Date().toISOString()
    });
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️ Resetting stepper...');
    sendToFrontend({
      type: 'status_update',
      status: 'resetting_sorter',
      message: 'Resetting sorter to home position',
      timestamp: new Date().toISOString()
    });
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
    
    sendToFrontend({
      type: 'cycle_complete',
      message: 'Item processing completed successfully',
      cycleTime: cycleTime,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      timestamp: new Date().toISOString()
    });
    
    // RESET FOR NEXT USER
    resetSystemForNextUser();
    
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
    
    sendToFrontend({
      type: 'cycle_failed',
      message: `Processing failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });
    
    await emergencyStop();
    resetSystemForNextUser();
  }
}

function resetSystemForNextUser() {
  state.cycleInProgress = false;
  state.autoCycleEnabled = false;
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.isProcessingQR = false;
  
  sendToFrontend({
    type: 'ready',
    message: 'System ready for next user',
    timestamp: new Date().toISOString()
  });
  
  console.log('🔄 SYSTEM RESET COMPLETE - Ready for next user!');
  console.log('📱 Scan next QR code anytime...\n');
}

async function emergencyStop() {
  console.log('🛑 Emergency stop...');
  sendToFrontend({
    type: 'emergency_stop',
    message: 'Emergency stop activated',
    timestamp: new Date().toISOString()
  });
  
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
  } catch (error) {
    console.error('❌ Emergency stop failed:', error.message);
  }
}

// ======= HARDWARE WEBSOCKET =======
function connectHardwareWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ Hardware WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`📡 Hardware message: ${message.function}`, message.data);
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      // AI Photo result
      if (message.function === 'aiPhoto') {
        // Clear auto photo timer when we get AI result
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
        
        sendToFrontend({
          type: 'ai_result',
          message: `AI detected: ${state.aiResult.materialType}`,
          materialType: state.aiResult.materialType,
          confidence: state.aiResult.matchRate,
          timestamp: new Date().toISOString()
        });
        
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...\n');
            sendToFrontend({
              type: 'status_update',
              status: 'weighing',
              message: 'Proceeding to weight measurement',
              timestamp: new Date().toISOString()
            });
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
            sendToFrontend({
              type: 'status_update',
              status: 'low_confidence',
              message: 'AI confidence too low, please try again',
              timestamp: new Date().toISOString()
            });
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
        
        sendToFrontend({
          type: 'weight_result',
          message: `Weight measured: ${state.weight.weight}g`,
          weight: state.weight.weight,
          timestamp: new Date().toISOString()
        });
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${state.calibrationAttempts}/2)...\n`);
          sendToFrontend({
            type: 'status_update',
            status: 'calibrating',
            message: 'Calibrating weight sensor',
            timestamp: new Date().toISOString()
          });
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
          // Clear auto photo timer since we got manual detection
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
          sendToFrontend({
            type: 'status_update',
            status: 'object_detected',
            message: 'Object detected - Taking photo',
            timestamp: new Date().toISOString()
          });
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ Hardware WebSocket error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ Hardware WebSocket closed, reconnecting...');
    setTimeout(connectHardwareWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ Hardware WebSocket error:', error.message);
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
  
  connectHardwareWebSocket();
  setupFrontendWebSocketServer();
  
  setTimeout(() => {
    requestModuleId();
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
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  if (state.frontendWs) state.frontendWs.close();
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v9.6 - FRONTEND INTEGRATION');
console.log('🔄 FULLY AUTOMATED WITH WEB FRONTEND');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log(`🌐 Frontend: ws://localhost:${CONFIG.frontend.port}${CONFIG.frontend.path}`);
console.log('========================================');
console.log('🎯 FEATURES:');
console.log('   ✅ Web frontend QR scanning');
console.log('   ✅ Real-time status updates');
console.log('   ✅ Full automation sequence');
console.log('   ✅ Real-time frontend communication');
console.log('   ✅ MQTT integration');
console.log('========================================');
console.log('⏳ Starting system...\n');