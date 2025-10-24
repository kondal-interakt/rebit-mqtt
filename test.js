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
      sessionUpdate: 'rvm/RVM-3101/session/update',
      userInterface: 'rvm/RVM-3101/ui/state' // NEW: UI state updates
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
    compactor: 24000,
    positionSettle: 500,
    gateOperation: 1000,
    itemProcessing: 15000, // Industry standard: 15s per item
    sessionTimeout: 120000, // 2 minutes
    nextItemWait: 5000, // Wait 5s for next item detection
    userFeedbackDelay: 2000 // Show feedback for 2s
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// INDUSTRY STANDARD STATES
const MACHINE_STATES = {
  IDLE: 'IDLE',
  READY: 'READY', // Green - Insert bottle
  PROCESSING: 'PROCESSING', // Yellow - Processing...
  ACCEPTED: 'ACCEPTED', // Green check - Accepted
  REJECTED: 'REJECTED', // Red cross - Not accepted
  SESSION_COMPLETE: 'SESSION_COMPLETE' // Blue - Session complete
};

const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  calibrationAttempts: 0,
  ws: null,
  
  // INDUSTRY STANDARD: Machine state management
  machineState: MACHINE_STATES.IDLE,
  currentSession: null,
  cycleInProgress: false,
  itemDetectionEnabled: false,
  
  // Timers
  sessionTimer: null,
  feedbackTimer: null,
  autoPhotoTimer: null
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// INDUSTRY STANDARD: Set machine state with UI updates
function setMachineState(newState) {
  state.machineState = newState;
  console.log(`🏭 MACHINE STATE: ${newState}`);
  
  // Update frontend UI
  mqttClient.publish(CONFIG.mqtt.topics.userInterface, JSON.stringify({
    state: newState,
    timestamp: new Date().toISOString()
  }));
}

// INDUSTRY STANDARD: Session management
function startNewSession(userId, userData) {
  const sessionId = generateSessionId();
  
  state.currentSession = {
    id: sessionId,
    userId: userId,
    userData: userData,
    items: [],
    startTime: new Date().toISOString(),
    totalWeight: 0,
    totalItems: 0,
    active: true
  };
  
  console.log('\n========================================');
  console.log('🏭 INDUSTRY STANDARD SESSION STARTED');
  console.log(`📋 Session: ${sessionId}`);
  console.log(`👤 User: ${userId}`);
  console.log('🔵 State: READY (Insert bottle)');
  console.log('========================================\n');
  
  // Start session timeout
  state.sessionTimer = setTimeout(() => {
    console.log('⏰ Session timeout - auto ending');
    endSession('timeout');
  }, CONFIG.timing.sessionTimeout);
  
  // Set machine to READY state
  setMachineState(MACHINE_STATES.READY);
  state.itemDetectionEnabled = true;
  
  // Notify frontend
  mqttClient.publish(CONFIG.mqtt.topics.sessionUpdate, JSON.stringify({
    type: 'session_start',
    sessionId: sessionId,
    userId: userId,
    userData: userData,
    state: MACHINE_STATES.READY,
    message: 'INSERT BOTTLE',
    timestamp: new Date().toISOString()
  }));
  
  return sessionId;
}

// INDUSTRY STANDARD: Add item to session
function addItemToSession(aiResult, weight) {
  if (!state.currentSession?.active) return null;
  
  const item = {
    id: `item-${Date.now()}`,
    materialType: aiResult.materialType,
    className: aiResult.className,
    confidence: aiResult.matchRate,
    weight: weight.weight,
    rawWeight: weight.rawWeight,
    timestamp: new Date().toISOString()
  };
  
  state.currentSession.items.push(item);
  state.currentSession.totalWeight += weight.weight;
  state.currentSession.totalItems++;
  
  console.log(`\n📦 ITEM PROCESSED - Session Total: ${state.currentSession.totalItems} items, ${state.currentSession.totalWeight.toFixed(1)}g`);
  
  // Reset session timeout on each successful item
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = setTimeout(() => endSession('timeout'), CONFIG.timing.sessionTimeout);
  }
  
  // Notify frontend
  mqttClient.publish(CONFIG.mqtt.topics.sessionUpdate, JSON.stringify({
    type: 'item_processed',
    sessionId: state.currentSession.id,
    item: item,
    totalItems: state.currentSession.totalItems,
    totalWeight: state.currentSession.totalWeight,
    state: MACHINE_STATES.ACCEPTED,
    message: 'ITEM ACCEPTED',
    timestamp: new Date().toISOString()
  }));
  
  return item;
}

// INDUSTRY STANDARD: End session
async function endSession(reason = 'completed') {
  if (!state.currentSession?.active) return;
  
  console.log('\n========================================');
  console.log('🏭 SESSION ENDED');
  console.log(`📋 Session: ${state.currentSession.id}`);
  console.log(`📊 Total Items: ${state.currentSession.totalItems}`);
  console.log(`⚖️ Total Weight: ${state.currentSession.totalWeight.toFixed(1)}g`);
  console.log(`🔚 Reason: ${reason}`);
  console.log('========================================\n');
  
  // Clear timers
  if (state.sessionTimer) clearTimeout(state.sessionTimer);
  if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  // Set session complete state
  setMachineState(MACHINE_STATES.SESSION_COMPLETE);
  state.itemDetectionEnabled = false;
  
  // Prepare session data
  const sessionData = {
    sessionId: state.currentSession.id,
    userId: state.currentSession.userId,
    userData: state.currentSession.userData,
    items: state.currentSession.items,
    totalItems: state.currentSession.totalItems,
    totalWeight: state.currentSession.totalWeight,
    startTime: state.currentSession.startTime,
    endTime: new Date().toISOString(),
    duration: Math.round((Date.now() - new Date(state.currentSession.startTime).getTime()) / 1000),
    endReason: reason
  };
  
  // Send final data to backend
  mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(sessionData));
  
  // Notify frontend
  mqttClient.publish(CONFIG.mqtt.topics.sessionUpdate, JSON.stringify({
    type: 'session_end',
    ...sessionData,
    state: MACHINE_STATES.SESSION_COMPLETE,
    message: 'SESSION COMPLETE'
  }));
  
  // Reset system
  await resetSystemAfterSession();
  
  // Clear session data after delay
  setTimeout(() => {
    state.currentSession = null;
    setMachineState(MACHINE_STATES.IDLE);
  }, 5000);
}

// INDUSTRY STANDARD: Reset system after session
async function resetSystemAfterSession() {
  console.log('🔄 Resetting system to idle state...');
  
  try {
    // Close gate
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    // Stop all motors
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // Reset stepper to home
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    console.log('✅ System reset complete');
  } catch (error) {
    console.error('❌ Reset error:', error.message);
  }
}

// INDUSTRY STANDARD: Material type determination
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

// INDUSTRY STANDARD: Execute hardware commands
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

// INDUSTRY STANDARD: Process single item (core logic)
async function processSingleItem() {
  if (state.cycleInProgress || !state.currentSession?.active) {
    console.log('⚠️ Cannot process - cycle in progress or no active session');
    return;
  }

  state.cycleInProgress = true;
  setMachineState(MACHINE_STATES.PROCESSING);

  console.log('\n========================================');
  console.log('🏭 PROCESSING ITEM');
  console.log('========================================\n');

  try {
    // Step 1: Ensure gate is open
    console.log('🚪 Ensuring gate is open...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);

    // Step 2: Transport to weight station
    console.log('⚖️ Moving to weight position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Step 3: Transport to processing station
    console.log('📦 Moving to processing position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);

    // Step 4: Dump to crusher
    console.log('🔄 Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);

    // Step 5: Compact material
    console.log('🗜️ Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);

    // Step 6: Return to ready position
    console.log('🔙 Returning to ready position...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Step 7: Add to session and show acceptance
    const item = addItemToSession(state.aiResult, state.weight);
    
    console.log('\n========================================');
    console.log('✅ ITEM PROCESSED SUCCESSFULLY');
    console.log(`📍 Material: ${state.aiResult.materialType}`);
    console.log(`⚖️ Weight: ${state.weight.weight}g`);
    console.log(`📊 Session Total: ${state.currentSession.totalItems} items`);
    console.log('========================================\n');

    // Show accepted feedback
    setMachineState(MACHINE_STATES.ACCEPTED);

    // INDUSTRY STANDARD: Brief acceptance feedback, then ready for next
    state.feedbackTimer = setTimeout(() => {
      if (state.currentSession?.active) {
        setMachineState(MACHINE_STATES.READY);
        state.itemDetectionEnabled = true;
        console.log('🟢 READY FOR NEXT BOTTLE');
        
        mqttClient.publish(CONFIG.mqtt.topics.sessionUpdate, JSON.stringify({
          type: 'ready_for_next',
          sessionId: state.currentSession.id,
          state: MACHINE_STATES.READY,
          message: 'INSERT NEXT BOTTLE',
          timestamp: new Date().toISOString()
        }));
      }
    }, CONFIG.timing.userFeedbackDelay);

  } catch (error) {
    console.error('\n❌ ITEM PROCESSING FAILED:', error.message);
    
    setMachineState(MACHINE_STATES.REJECTED);
    
    mqttClient.publish(CONFIG.mqtt.topics.sessionUpdate, JSON.stringify({
      type: 'item_error',
      sessionId: state.currentSession?.id,
      error: error.message,
      state: MACHINE_STATES.REJECTED,
      message: 'PROCESSING ERROR',
      timestamp: new Date().toISOString()
    }));

    // Return to ready state after error
    state.feedbackTimer = setTimeout(() => {
      if (state.currentSession?.active) {
        setMachineState(MACHINE_STATES.READY);
        state.itemDetectionEnabled = true;
      }
    }, CONFIG.timing.userFeedbackDelay);

  } finally {
    // Clear current item data
    state.aiResult = null;
    state.weight = null;
    state.cycleInProgress = false;
  }
}

// INDUSTRY STANDARD: Emergency stop
async function emergencyStop() {
  console.log('\n🚨 EMERGENCY STOP\n');
  
  try {
    await executeCommand('closeGate');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // End current session if active
    if (state.currentSession?.active) {
      await endSession('emergency_stop');
    }
    
    // Clear all timers
    if (state.sessionTimer) clearTimeout(state.sessionTimer);
    if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    
    setMachineState(MACHINE_STATES.IDLE);
    state.itemDetectionEnabled = false;
    
    console.log('✅ Emergency stop complete\n');
  } catch (error) {
    console.error('❌ Emergency stop error:', error.message);
  }
}

// WebSocket connection for hardware communication
function connectWebSocket() {
  if (state.ws) {
    state.ws.close();
  }
  
  console.log('🔌 Connecting to WebSocket...');
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected\n');
  });
  
  state.ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === 'qrcode') {
        console.log('📱 QR from local scanner:', message.data);
        return;
      }
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`🔧 Module ID: ${state.moduleId}\n`);
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className || 'Unknown',
          taskId: aiData.taskId || 'unknown',
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        // INDUSTRY STANDARD: If valid material, proceed to weight
        if (state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Valid material - proceeding to weight measurement\n');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Low confidence (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
            setMachineState(MACHINE_STATES.REJECTED);
            setTimeout(() => {
              if (state.currentSession?.active) setMachineState(MACHINE_STATES.READY);
            }, 2000);
          }
        } else {
          console.log('❌ Unknown material - rejected\n');
          setMachineState(MACHINE_STATES.REJECTED);
          setTimeout(() => {
            if (state.currentSession?.active) setMachineState(MACHINE_STATES.READY);
          }, 2000);
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
        
        console.log(`⚖️ Weight: ${state.weight.weight}g`);
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        // Handle calibration if needed
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating (${state.calibrationAttempts}/2)...\n`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        // INDUSTRY STANDARD: If we have valid AI and weight, process the item
        if (state.aiResult && state.aiResult.materialType !== 'UNKNOWN' && 
            state.weight.weight > 1 && !state.cycleInProgress) {
          console.log('✅ Starting item processing cycle...\n');
          setTimeout(() => processSingleItem(), 1000);
        }
        return;
      }
      
      // INDUSTRY STANDARD: Item detection sensor
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        // Code 4 typically means object detected
        if (code === 4 && state.itemDetectionEnabled && !state.cycleInProgress) {
          console.log('👤 BOTTLE DETECTED! Starting identification...\n');
          
          // Disable further detection until this item is processed
          state.itemDetectionEnabled = false;
          
          // Clear any existing auto-photo timer
          if (state.autoPhotoTimer) {
            clearTimeout(state.autoPhotoTimer);
            state.autoPhotoTimer = null;
          }
          
          // Take photo for identification
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

// MQTT Client for backend communication
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  // Subscribe to relevant topics
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrScan);
  
  // Publish online status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    state: state.machineState,
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
      // Check if session already active
      if (state.currentSession?.active) {
        console.log('⚠️ Session already active, ignoring QR scan');
        return;
      }
      
      console.log('\n========================================');
      console.log('✅ QR VALIDATED BY BACKEND');
      console.log('========================================');
      console.log(`👤 User: ${payload.userName || payload.userId}`);
      console.log(`🔑 Session Code: ${payload.sessionCode}`);
      console.log('========================================\n');
      
      // INDUSTRY STANDARD: Start new session
      startNewSession(payload.userId, {
        name: payload.userName,
        sessionCode: payload.sessionCode,
        timestamp: payload.timestamp
      });
      
      // Initialize system for session
      console.log('🔧 Initializing system for session...');
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(2000);
      
      console.log('🚪 Opening gate for session...');
      await executeCommand('openGate');
      await delay(CONFIG.timing.gateOperation);
      
      console.log('✅ Session initialization complete - Ready for bottles!\n');
      
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        await emergencyStop();
        return;
      }
      
      if (payload.action === 'endSession' && state.currentSession?.active) {
        console.log('🔚 Manual session end requested');
        await endSession('manual_end');
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await executeCommand('takePhoto');
        return;
      }
      
      // Other commands...
    }
    
  } catch (error) {
    console.error('❌ MQTT error:', error.message);
  }
});

// Helper function to request module ID
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

// Graceful shutdown
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  
  // End current session if active
  if (state.currentSession?.active) {
    endSession('shutdown');
  }
  
  // Publish offline status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  // Cleanup
  if (state.ws) state.ws.close();
  if (state.sessionTimer) clearTimeout(state.sessionTimer);
  if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  mqttClient.end();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);

console.log('========================================');
console.log('🏭 RVM AGENT - INDUSTRY STANDARD FLOW');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Continuous Single-Item Processing');
console.log('✅ TOMRA-style User Experience');
console.log('✅ 15s per item target');
console.log('✅ Professional State Management');
console.log('========================================');
console.log('⏳ Starting...\n');