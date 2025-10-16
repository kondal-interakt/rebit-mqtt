// motor-test.js - Test script to identify which motor controls the basket
// Run with: node motor-test.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const readline = require('readline');

// ========== CONFIGURATION ==========
const MQTT_CONFIG = {
  broker: 'mqtts://mqtt.ceewen.xyz:8883',
  username: 'mqttuser',
  password: 'mqttUser@2025',
  caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
  deviceId: 'RVM-3101'
};

const API_CONFIG = {
  baseUrl: 'http://localhost:8081',
  moduleId: null  // Will be fetched dynamically
};

// ========== UTILITY FUNCTIONS ==========
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer.trim());
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== MQTT TEST FUNCTIONS ==========
async function testViaMQTT() {
  console.log('\n📡 TESTING VIA MQTT...\n');
  
  const client = mqtt.connect(MQTT_CONFIG.broker, {
    username: MQTT_CONFIG.username,
    password: MQTT_CONFIG.password,
    ca: fs.readFileSync(MQTT_CONFIG.caFile),
    rejectUnauthorized: false
  });

  return new Promise((resolve, reject) => {
    client.on('connect', async () => {
      console.log('✅ Connected to MQTT broker');
      const topic = `rvm/${MQTT_CONFIG.deviceId}/commands`;
      
      console.log('\n========== AUTOMATED MOTOR TESTS ==========\n');
      
      // Test 1: Find basket motor automatically
      console.log('🔍 Running automatic basket motor detection...');
      console.log('⚠️  WATCH THE MACHINE CAREFULLY!\n');
      
      client.publish(topic, JSON.stringify({ action: 'findBasketMotor' }));
      await delay(15000); // Wait for all motors to be tested
      
      // Test 2: Individual motor tests
      console.log('\n🔧 Now testing individual motors...\n');
      
      // Test Motor 05
      console.log('Testing Motor 05...');
      client.publish(topic, JSON.stringify({
        action: 'testMotor',
        motorId: '05',
        testAction: 'forward'
      }));
      await delay(5000);
      
      // Test Motor 06
      console.log('Testing Motor 06...');
      client.publish(topic, JSON.stringify({
        action: 'testMotor',
        motorId: '06',
        testAction: 'forward'
      }));
      await delay(5000);
      
      // Test Motor 07 (if exists)
      console.log('Testing Motor 07 (if exists)...');
      client.publish(topic, JSON.stringify({
        action: 'testMotor',
        motorId: '07',
        testAction: 'forward'
      }));
      await delay(5000);
      
      console.log('\n✅ MQTT tests complete!');
      client.end();
      resolve();
    });

    client.on('error', err => {
      console.error('❌ MQTT error:', err.message);
      reject(err);
    });
  });
}

// ========== DIRECT API TEST FUNCTIONS ==========
async function getModuleId() {
  try {
    console.log('📡 Getting module ID...');
    const response = await axios.post(`${API_CONFIG.baseUrl}/system/serial/getModuleId`, {});
    // Module ID will be received via WebSocket, so we'll use a default for now
    API_CONFIG.moduleId = '09'; // Default, update if different
    console.log(`✅ Using module ID: ${API_CONFIG.moduleId}`);
    return API_CONFIG.moduleId;
  } catch (err) {
    console.log('⚠️  Could not fetch module ID, using default: 09');
    API_CONFIG.moduleId = '09';
    return API_CONFIG.moduleId;
  }
}

async function testMotorDirect(motorId, action = '03', duration = 3000) {
  console.log(`\n🔧 Testing Motor ${motorId}...`);
  console.log(`   Action: ${action} (00=stop, 01=reverse, 02=middle, 03=forward)`);
  console.log(`   Duration: ${duration}ms`);
  console.log(`   ⚠️  WATCH: Does the BASKET move?\n`);
  
  try {
    // Start motor
    await axios.post(`${API_CONFIG.baseUrl}/system/serial/motorSelect`, {
      moduleId: API_CONFIG.moduleId,
      motorId: motorId,
      type: action,
      deviceType: 1
    });
    
    console.log(`   ✅ Motor ${motorId} started`);
    
    // Wait
    await delay(duration);
    
    // Stop motor
    await axios.post(`${API_CONFIG.baseUrl}/system/serial/motorSelect`, {
      moduleId: API_CONFIG.moduleId,
      motorId: motorId,
      type: '00',
      deviceType: 1
    });
    
    console.log(`   ✅ Motor ${motorId} stopped`);
    
  } catch (err) {
    console.error(`   ❌ Error testing motor ${motorId}:`, err.message);
  }
}

async function testStepperDirect(position = '03', duration = 4000) {
  console.log(`\n🔧 Testing Stepper Motor (Module 0F)...`);
  console.log(`   Position: ${position}`);
  console.log(`   Duration: ${duration}ms`);
  console.log(`   ⚠️  WATCH: Does the BASKET or YELLOW DRUM move?\n`);
  
  try {
    // Move stepper
    await axios.post(`${API_CONFIG.baseUrl}/system/serial/stepMotorSelect`, {
      moduleId: '0F',  // Stepper always uses 0F
      type: position,
      deviceType: 1
    });
    
    console.log(`   ✅ Stepper moved to position ${position}`);
    
    // Wait
    await delay(duration);
    
    // Return to home
    await axios.post(`${API_CONFIG.baseUrl}/system/serial/stepMotorSelect`, {
      moduleId: '0F',
      type: '01',  // Home position
      deviceType: 1
    });
    
    console.log(`   ✅ Stepper returned to home`);
    
  } catch (err) {
    console.error(`   ❌ Error testing stepper:`, err.message);
  }
}

async function testViaAPI() {
  console.log('\n🔌 TESTING VIA DIRECT API...\n');
  
  // Get module ID first
  await getModuleId();
  await delay(1000);
  
  console.log('\n========== MOTOR IDENTIFICATION TESTS ==========');
  console.log('📋 We will test each motor for 3 seconds');
  console.log('⚠️  WATCH CAREFULLY which motor moves the WHITE BASKET\n');
  
  await askQuestion('Press ENTER to start testing...');
  
  // Test known motors first to understand the system
  console.log('\n--- Testing Known Motors ---');
  
  // Test Gate (Motor 01)
  console.log('\n1️⃣ Testing Motor 01 (Gate)...');
  await testMotorDirect('01', '03', 2000);
  await delay(2000);
  
  // Test Belt (Motor 02)
  console.log('\n2️⃣ Testing Motor 02 (Belt)...');
  await testMotorDirect('02', '02', 2000);
  await delay(2000);
  
  // Test Pusher (Motor 03)
  console.log('\n3️⃣ Testing Motor 03 (Pusher)...');
  await testMotorDirect('03', '03', 2000);
  await delay(2000);
  
  // Test Compactor (Motor 04)
  console.log('\n4️⃣ Testing Motor 04 (Compactor)...');
  await testMotorDirect('04', '01', 2000);
  await delay(2000);
  
  console.log('\n--- Testing Unknown Motors (Possible Basket) ---');
  
  // Test Motor 05
  console.log('\n5️⃣ Testing Motor 05 (Unknown - Possible Basket)...');
  await testMotorDirect('05', '03', 3000);
  const motor05 = await askQuestion('Did Motor 05 move the BASKET? (y/n): ');
  await delay(1000);
  
  // Test Motor 06
  console.log('\n6️⃣ Testing Motor 06 (Unknown - Possible Basket)...');
  await testMotorDirect('06', '03', 3000);
  const motor06 = await askQuestion('Did Motor 06 move the BASKET? (y/n): ');
  await delay(1000);
  
  // Test Motor 07
  console.log('\n7️⃣ Testing Motor 07 (If exists)...');
  await testMotorDirect('07', '03', 3000);
  const motor07 = await askQuestion('Did Motor 07 move the BASKET? (y/n): ');
  await delay(1000);
  
  // Test Stepper
  console.log('\n8️⃣ Testing Stepper Motor (Module 0F)...');
  await testStepperDirect('03', 4000);
  const stepperResult = await askQuestion('Did the Stepper move the BASKET or YELLOW DRUM? (basket/drum/none): ');
  
  // Results
  console.log('\n========== TEST RESULTS ==========\n');
  
  if (motor05.toLowerCase() === 'y') {
    console.log('✅ Motor 05 controls the BASKET');
    console.log('📝 Update your code: sorter.motorId = "05"');
  }
  if (motor06.toLowerCase() === 'y') {
    console.log('✅ Motor 06 controls the BASKET');
    console.log('📝 Update your code: sorter.motorId = "06"');
  }
  if (motor07.toLowerCase() === 'y') {
    console.log('✅ Motor 07 controls the BASKET');
    console.log('📝 Update your code: sorter.motorId = "07"');
  }
  
  if (stepperResult.toLowerCase().includes('basket')) {
    console.log('✅ Stepper (0F) controls the BASKET');
    console.log('📝 Keep using stepper commands for basket');
  } else if (stepperResult.toLowerCase().includes('drum')) {
    console.log('⚠️  Stepper (0F) controls the YELLOW DRUM (not the basket)');
  }
  
  if (motor05.toLowerCase() !== 'y' && motor06.toLowerCase() !== 'y' && 
      motor07.toLowerCase() !== 'y' && !stepperResult.toLowerCase().includes('basket')) {
    console.log('❌ No motor identified for the basket!');
    console.log('   Try testing motors 08, 09, 0A manually');
  }
}

// ========== INTERACTIVE MANUAL TEST ==========
async function interactiveTest() {
  console.log('\n🎮 INTERACTIVE MOTOR CONTROL\n');
  
  await getModuleId();
  
  while (true) {
    console.log('\n--- Motor Control Menu ---');
    console.log('1. Test motor (forward)');
    console.log('2. Test motor (reverse)');
    console.log('3. Test motor (middle position)');
    console.log('4. Stop motor');
    console.log('5. Test stepper positions');
    console.log('6. Custom command');
    console.log('0. Exit');
    
    const choice = await askQuestion('\nEnter choice: ');
    
    if (choice === '0') break;
    
    switch(choice) {
      case '1':
        const motor1 = await askQuestion('Enter motor ID (01-0A): ');
        await testMotorDirect(motor1, '03', 3000);
        break;
        
      case '2':
        const motor2 = await askQuestion('Enter motor ID (01-0A): ');
        await testMotorDirect(motor2, '01', 3000);
        break;
        
      case '3':
        const motor3 = await askQuestion('Enter motor ID (01-0A): ');
        await testMotorDirect(motor3, '02', 3000);
        break;
        
      case '4':
        const motor4 = await askQuestion('Enter motor ID (01-0A): ');
        await testMotorDirect(motor4, '00', 0);
        break;
        
      case '5':
        const pos = await askQuestion('Enter position (00-03): ');
        await testStepperDirect(pos, 4000);
        break;
        
      case '6':
        const motorId = await askQuestion('Enter motor ID: ');
        const type = await askQuestion('Enter type (00-03): ');
        const duration = await askQuestion('Enter duration (ms): ');
        await testMotorDirect(motorId, type, parseInt(duration));
        break;
    }
  }
}

// ========== MAIN PROGRAM ==========
async function main() {
  console.log('========================================');
  console.log('🔧 RVM MOTOR TESTING UTILITY');
  console.log('========================================');
  console.log('This script will help identify which motor');
  console.log('controls the white basket mechanism\n');
  
  console.log('Select test method:');
  console.log('1. MQTT Test (requires agent running)');
  console.log('2. Direct API Test');
  console.log('3. Interactive Manual Control');
  console.log('4. Run All Tests');
  
  const choice = await askQuestion('\nEnter choice (1-4): ');
  
  try {
    switch(choice) {
      case '1':
        await testViaMQTT();
        break;
      case '2':
        await testViaAPI();
        break;
      case '3':
        await interactiveTest();
        break;
      case '4':
        await testViaMQTT();
        await testViaAPI();
        break;
      default:
        console.log('Invalid choice');
    }
  } catch (err) {
    console.error('\n❌ Error:', err.message);
  }
  
  console.log('\n========================================');
  console.log('📝 NEXT STEPS:');
  console.log('1. Identify which motor controls the basket');
  console.log('2. Update your agent code with correct motorId');
  console.log('3. Test the complete cycle');
  console.log('========================================\n');
  
  rl.close();
  process.exit(0);
}

// Run the program
main().catch(console.error);