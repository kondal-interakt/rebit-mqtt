const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

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
      qrScan: 'rvm/RVM-3101/qr/scanned',
      error: 'rvm/RVM-3101/error'  // NEW: Error topic
    }
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
    autoPhotoDelay: 8000,  // ← CHANGED: 8 seconds
    cycleTimeout: 30000,   // NEW: 30 second timeout for full cycle
    weightTimeout: 15000,  // NEW: 15 second timeout waiting for valid weight
    aiTimeout: 12000       // NEW: 12 second timeout waiting for AI result after photo
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

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
  currentUserData: null,
  autoPhotoTimer: null,
  cycleTimeoutTimer: null,      // NEW: Cycle timeout timer
  weightTimeoutTimer: null,      // NEW: Weight timeout timer
  aiTimeoutTimer: null,          // NEW: AI result timeout timer
  objectDetectedTime: null       // NEW: Track when object was detected
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

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
  
  console.log(`🔧 Executing: ${action}`, apiPayload);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    console.error(`❌ ${action} failed:`, error.message);
    throw error;
  }
}

// ============ NEW: Clear all timers ============
function clearAllTimers() {
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  if (state.cycleTimeoutTimer) {
    clearTimeout(state.cycleTimeoutTimer);
    state.cycleTimeoutTimer = null;
  }
  if (state.weightTimeoutTimer) {
    clearTimeout(state.weightTimeoutTimer);
    state.weightTimeoutTimer = null;
  }
  if (state.aiTimeoutTimer) {
    clearTimeout(state.aiTimeoutTimer);
    state.aiTimeoutTimer = null;
  }
}

// ============ NEW: Publish error to MQTT ============
function publishError(errorType, errorMessage, details = {}) {
  const errorPayload = {
    deviceId: CONFIG.device.id,
    errorType: errorType,
    message: errorMessage,
    details: details,
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    userId: state.currentUserId
  };
  
  console.error(`\n❌ ERROR: ${errorType}`);
  console.error(`   Message: ${errorMessage}`);
  if (Object.keys(details).length > 0) {
    console.error(`   Details:`, details);
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.error, JSON.stringify(errorPayload));
}

// ============ IMPROVED: Reset system for next scan with error handling ============
async function resetSystemForNextScan(reason = 'normal') {
  console.log('\n========================================');
  console.log(`🔄 RESETTING SYSTEM (Reason: ${reason})`);
  console.log('========================================\n');
  
  // Clear all timers first
  clearAllTimers();
  
  try {
    // Close the gate
    console.log('🚪 Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate closed\n');
    
    // Stop all motors
    console.log('🛑 Stopping all motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Motors stopped\n');
    
    // Reset stepper to home position
    console.log('🏠 Resetting stepper to home...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Stepper reset\n');
    
  } catch (error) {
    console.error('❌ Reset error:', error.message);
    publishError('RESET_ERROR', 'Failed to reset system', { error: error.message });
  }
  
  // Clear all state variables
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.calibrationAttempts = 0;
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  state.objectDetectedTime = null;
  
  console.log('========================================');
  console.log('✅ SYSTEM READY FOR NEXT QR SCAN');
  console.log('========================================\n');
}

// ============ IMPROVED: Auto cycle with error handling ============
async function executeAutoCycle() {
  // Clear any existing cycle timeout
  if (state.cycleTimeoutTimer) {
    clearTimeout(state.cycleTimeoutTimer);
  }
  
  // Set cycle timeout
  state.cycleTimeoutTimer = setTimeout(async () => {
    console.error('\n⏱️ CYCLE TIMEOUT - Taking too long!\n');
    publishError('CYCLE_TIMEOUT', 'Cycle exceeded maximum time', {
      hasAIResult: !!state.aiResult,
      hasWeight: !!state.weight,
      weight: state.weight?.weight
    });
    await resetSystemForNextScan('cycle_timeout');
  }, CONFIG.timing.cycleTimeout);
  
  // Validate data
  if (!state.aiResult) {
    console.log('⚠️ Missing AI result');
    publishError('MISSING_DATA', 'AI result not available');
    state.cycleInProgress = false;
    clearTimeout(state.cycleTimeoutTimer);
    await resetSystemForNextScan('missing_ai_result');
    return;
  }
  
  if (!state.weight) {
    console.log('⚠️ Missing weight data');
    publishError('MISSING_DATA', 'Weight data not available');
    state.cycleInProgress = false;
    clearTimeout(state.cycleTimeoutTimer);
    await resetSystemForNextScan('missing_weight');
    return;
  }
  
  // ============ NEW: Check for invalid weight ============
  if (state.weight.weight <= 1) {
    console.error('\n❌ INVALID WEIGHT - Weight too low or zero!\n');
    publishError('INVALID_WEIGHT', 'Weight is too low or zero', {
      weight: state.weight.weight,
      rawWeight: state.weight.rawWeight,
      calibrationAttempts: state.calibrationAttempts
    });
    state.cycleInProgress = false;
    clearTimeout(state.cycleTimeoutTimer);
    await resetSystemForNextScan('invalid_weight');
    return;
  }

  console.log('\n========================================');
  console.log('🔄 STARTING AUTO CYCLE');
  console.log('========================================');
  console.log(`📦 Material: ${state.aiResult.materialType}`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');

  try {
    // Close gate
    console.log('🚪 Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    // Belt to weight scale
    console.log('📦 Moving to weight scale...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(500);
    
    // Belt to stepper
    console.log('📦 Moving to stepper...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(500);
    
    // Determine position
    let position;
    switch (state.aiResult.materialType) {
      case 'METAL_CAN':
        position = CONFIG.motors.stepper.positions.metalCan;
        console.log('🥫 Rotating to metal can bin...');
        break;
      case 'PLASTIC_BOTTLE':
        position = CONFIG.motors.stepper.positions.plasticBottle;
        console.log('🍶 Rotating to plastic bottle bin...');
        break;
      default:
        position = CONFIG.motors.stepper.positions.home;
        console.log('🏠 Rotating to home...');
    }
    
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    // Compact
    console.log('🗜️ Compacting...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await delay(500);
    
    // Return belt
    console.log('⏪ Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Reset stepper
    console.log('🏠 Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    console.log('\n========================================');
    console.log('✅ CYCLE COMPLETE!');
    console.log('========================================\n');
    
    // Publish completion
    const completionData = {
      deviceId: CONFIG.device.id,
      sessionId: state.sessionId,
      userId: state.currentUserId,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      confidence: state.aiResult.matchRate,
      timestamp: new Date().toISOString()
    };
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(completionData));
    
    // Clear cycle timeout
    if (state.cycleTimeoutTimer) {
      clearTimeout(state.cycleTimeoutTimer);
      state.cycleTimeoutTimer = null;
    }
    
    // Reset for next scan
    await resetSystemForNextScan('cycle_complete');
    
  } catch (error) {
    console.error('❌ Cycle error:', error.message);
    publishError('CYCLE_ERROR', 'Error during cycle execution', { error: error.message });
    state.cycleInProgress = false;
    if (state.cycleTimeoutTimer) {
      clearTimeout(state.cycleTimeoutTimer);
      state.cycleTimeoutTimer = null;
    }
    await resetSystemForNextScan('cycle_error');
  }
}

async function emergencyStop() {
  console.log('\n⚠️ EMERGENCY STOP TRIGGERED\n');
  
  clearAllTimers();
  
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('closeGate');
  } catch (error) {
    console.error('❌ Emergency stop error:', error.message);
  }
  
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  
  console.log('✅ Emergency stop complete\n');
}

function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected\n');
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        console.log(`🔑 Module ID: ${state.moduleId}\n`);
        return;
      }
      
      if (message.function === '05') {
        // Clear AI timeout since we got a result
        if (state.aiTimeoutTimer) {
          clearTimeout(state.aiTimeoutTimer);
          state.aiTimeoutTimer = null;
        }
        
        const aiData = {
          className: message.data.className || 'unknown',
          probability: parseFloat(message.data.probability) || 0,
          taskId: message.data.taskId || 'unknown',
          timestamp: new Date().toISOString()
        };
        
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round(aiData.probability * 100),
          materialType: materialType,
          className: aiData.className,
          taskId: aiData.taskId,
          timestamp: aiData.timestamp
        };
        
        console.log(`🤖 AI: ${state.aiResult.className} (${state.aiResult.matchRate}%)`);
        console.log(`📊 Type: ${state.aiResult.materialType}\n`);
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        // ============ NEW: Handle UNKNOWN material type ============
        if (state.autoCycleEnabled && state.aiResult.materialType === 'UNKNOWN') {
          console.log('⚠️ No valid material detected (UNKNOWN)\n');
          publishError('UNKNOWN_MATERIAL', 'AI could not identify material type', {
            className: state.aiResult.className,
            confidence: state.aiResult.matchRate
          });
          await resetSystemForNextScan('unknown_material');
          return;
        }
        
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...\n');
            
            // ============ NEW: Start weight timeout ============
            state.weightTimeoutTimer = setTimeout(async () => {
              console.error('\n⏱️ WEIGHT TIMEOUT - No valid weight received!\n');
              publishError('WEIGHT_TIMEOUT', 'Did not receive valid weight in time', {
                hasAIResult: true,
                materialType: state.aiResult.materialType
              });
              await resetSystemForNextScan('weight_timeout');
            }, CONFIG.timing.weightTimeout);
            
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Low confidence (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
            publishError('LOW_CONFIDENCE', 'AI confidence below threshold', {
              confidence: state.aiResult.matchRate,
              threshold: thresholdPercent,
              materialType: state.aiResult.materialType
            });
            await resetSystemForNextScan('low_confidence');
          }
        }
        return;
      }
      
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
        
        console.log(`⚖️ Weight: ${state.weight.weight}g (Raw: ${weightValue})`);
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        // ============ IMPROVED: Weight validation with error handling ============
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Zero weight detected! Calibrating (${state.calibrationAttempts}/2)...\n`);
          
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        // ============ NEW: Handle failed calibration ============
        if (state.weight.weight <= 0 && state.calibrationAttempts >= 2) {
          console.error('\n❌ WEIGHT CALIBRATION FAILED - Weight still zero after 2 attempts!\n');
          publishError('CALIBRATION_FAILED', 'Weight is zero after calibration attempts', {
            attempts: state.calibrationAttempts,
            rawWeight: state.weight.rawWeight
          });
          
          // Clear weight timeout if exists
          if (state.weightTimeoutTimer) {
            clearTimeout(state.weightTimeoutTimer);
            state.weightTimeoutTimer = null;
          }
          
          await resetSystemForNextScan('calibration_failed');
          return;
        }
        
        // Weight is valid
        if (state.weight.weight > 0) {
          state.calibrationAttempts = 0;
          
          // Clear weight timeout since we got valid weight
          if (state.weightTimeoutTimer) {
            clearTimeout(state.weightTimeoutTimer);
            state.weightTimeoutTimer = null;
          }
        }
        
        // ============ IMPROVED: Start cycle with validation ============
        if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        } else if (state.autoCycleEnabled && state.weight.weight <= 1) {
          // Weight too low even though it's > 0
          console.error('\n⚠️ Weight too low for processing\n');
          publishError('WEIGHT_TOO_LOW', 'Weight below minimum threshold', {
            weight: state.weight.weight,
            threshold: 1
          });
          await resetSystemForNextScan('weight_too_low');
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          console.log('👤 OBJECT DETECTED!\n');
          state.objectDetectedTime = Date.now();
          
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
          
          // Start AI timeout
          state.aiTimeoutTimer = setTimeout(async () => {
            console.error('\n⏱️ AI TIMEOUT - No AI result received after photo!\n');
            publishError('AI_TIMEOUT', 'AI did not respond after taking photo', {
              timeSincePhoto: Date.now() - state.objectDetectedTime
            });
            await resetSystemForNextScan('ai_timeout');
          }, CONFIG.timing.aiTimeout);
          
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ WS error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ WS error:', error.message);
  });
}

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
  mqttClient.subscribe(CONFIG.mqtt.topics.qrScan);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  setTimeout(() => {
    requestModuleId();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.qrScan) {
      // Check if a cycle is already in progress
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring QR scan');
        return;
      }
      
      // Check if system already active
      if (state.autoCycleEnabled) {
        console.log('⚠️ System already active, ignoring QR scan');
        return;
      }
      
      console.log('\n========================================');
      console.log('✅ QR VALIDATED BY BACKEND');
      console.log('========================================');
      console.log(`👤 User: ${payload.userName || payload.userId}`);
      console.log(`🔑 Session: ${payload.sessionCode}`);
      console.log('========================================\n');
      
      state.currentUserId = payload.userId;
      state.currentUserData = {
        name: payload.userName,
        sessionCode: payload.sessionCode,
        timestamp: payload.timestamp
      };
      state.sessionId = generateSessionId();
      
      state.autoCycleEnabled = true;
      
      console.log('🔧 Resetting system...');
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(2000);
      console.log('✅ Reset complete\n');
      
      console.log('🚪 Opening gate...');
      await executeCommand('openGate');
      await delay(CONFIG.timing.gateOperation);
      console.log('✅ Gate opened!\n');
      
      console.log('⏱️  Auto photo in 8 seconds...\n');  // Updated message
      
      clearAllTimers();
      
      state.autoPhotoTimer = setTimeout(() => {
        console.log('📸 AUTO PHOTO (No object detected)!\n');
        
        // Start AI timeout
        state.aiTimeoutTimer = setTimeout(async () => {
          console.error('\n⏱️ AI TIMEOUT - No AI result received after auto photo!\n');
          publishError('AI_TIMEOUT', 'AI did not respond after taking auto photo', {
            reason: 'auto_photo_no_response'
          });
          await resetSystemForNextScan('ai_timeout');
        }, CONFIG.timing.aiTimeout);
        
        executeCommand('takePhoto');
      }, CONFIG.timing.autoPhotoDelay);
      
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
        clearAllTimers();
      }
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        await emergencyStop();
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        clearAllTimers();
        
        // Start AI timeout for manual photo if auto cycle is enabled
        if (state.autoCycleEnabled) {
          state.aiTimeoutTimer = setTimeout(async () => {
            console.error('\n⏱️ AI TIMEOUT - No AI result received after manual photo!\n');
            publishError('AI_TIMEOUT', 'AI did not respond after manual photo', {
              reason: 'manual_photo_no_response'
            });
            await resetSystemForNextScan('ai_timeout');
          }, CONFIG.timing.aiTimeout);
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
            className: 'MANUAL',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`🔧 Manual: ${payload.materialType}`);
          
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
    console.error('❌ MQTT error:', error.message);
  }
});

async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID failed:', error.message);
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  
  clearAllTimers();
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

console.log('========================================');
console.log('🚀 RVM AGENT - IMPROVED ERROR HANDLING');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ Auto photo: 8 seconds');
console.log('✅ AI timeout: 12 seconds');
console.log('✅ Weight timeout: 15 seconds');
console.log('✅ Cycle timeout: 30 seconds');
console.log('✅ Zero weight error handling');
console.log('✅ Missing bottle detection');
console.log('✅ UNKNOWN material auto-reset');
console.log('========================================');
console.log('⏳ Starting...\n');