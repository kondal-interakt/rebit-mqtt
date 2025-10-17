// test-qr-scanner-enhanced.js
const readline = require('readline');

console.log('========================================');
console.log('🧪 QR SCANNER TEST UTILITY - ENHANCED');
console.log('========================================');
console.log('Instructions:');
console.log('1. Run: node test-qr-scanner-enhanced.js');
console.log('2. Scan QR codes with your RVM scanner');
console.log('3. Check if data appears below');
console.log('4. Press Ctrl+C to exit');
console.log('========================================\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let scanCount = 0;
const scanHistory = [];

// Set timeout to detect if scanner is not working
const startupTimer = setTimeout(() => {
  console.log('⏰ No scans detected yet...');
  console.log('💡 Troubleshooting tips:');
  console.log('   - Make sure scanner is in "keyboard emulation" mode');
  console.log('   - Check USB connection');
  console.log('   - Try scanning a test QR code\n');
}, 5000);

rl.on('line', (input) => {
  // Clear the startup message after first successful scan
  if (scanCount === 0) {
    clearTimeout(startupTimer);
    console.log('🎉 First scan received! Scanner is working correctly.\n');
  }

  scanCount++;
  const timestamp = new Date().toLocaleTimeString();
  const scanData = {
    count: scanCount,
    timestamp: timestamp,
    data: input,
    length: input.length,
    isValid: input.length >= 8 && input.length <= 16
  };
  
  scanHistory.push(scanData);

  console.log('\n========================================');
  console.log(`📱 SCAN #${scanCount} - ${timestamp}`);
  console.log('========================================');
  console.log(`📊 Data: "${input}"`);
  console.log(`📏 Length: ${input.length} chars`);
  console.log(`✅ Format: ${scanData.isValid ? 'VALID' : 'CHECK FORMAT'}`);
  
  // Show data preview for long content
  if (input.length > 30) {
    console.log(`👀 Preview: "${input.substring(0, 30)}..."`);
  }
  
  console.log('========================================\n');
  console.log(`📊 Total scans: ${scanCount} | ⏳ Waiting for next...\n`);
});

// Enhanced raw mode for debugging
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  readline.emitKeypressEvents(process.stdin);
  
  let rawBuffer = '';
  let lastKeyTime = Date.now();
  
  process.stdin.on('keypress', (str, key) => {
    // Exit on Ctrl+C
    if (key && key.ctrl && key.name === 'c') {
      console.log('\n\n========================================');
      console.log('📊 SCAN SESSION SUMMARY');
      console.log('========================================');
      console.log(`Total scans: ${scanCount}`);
      console.log(`First scan: ${scanHistory[0]?.timestamp || 'None'}`);
      console.log(`Last scan: ${scanHistory[scanHistory.length-1]?.timestamp || 'None'}`);
      console.log('========================================\n');
      process.exit(0);
    }
    
    // Handle Enter key
    if (key && key.name === 'return') {
      if (rawBuffer.length > 0) {
        console.log(`\n🔍 Raw input detected: "${rawBuffer}"`);
        rawBuffer = '';
      }
      return;
    }
    
    // Capture characters
    if (str && str.length === 1) {
      rawBuffer += str;
      process.stdout.write('*'); // Show activity
      
      // Auto-submit if no activity for 500ms (some scanners don't send Enter)
      clearTimeout(lastKeyTime);
      lastKeyTime = setTimeout(() => {
        if (rawBuffer.length > 0) {
          console.log(`\n🔍 Auto-captured: "${rawBuffer}"`);
          rawBuffer = '';
        }
      }, 500);
    }
  });
}

// Handle scanner disconnection or errors
process.stdin.on('error', (err) => {
  console.error('❌ Scanner input error:', err.message);
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Test session ended.');
  process.exit(0);
});