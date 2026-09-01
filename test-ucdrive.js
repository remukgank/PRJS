/**
 * test-ucdrive.js
 * Standalone test untuk ucdrive.js - validate sintaks, require, dan test API call.
 */

const { getShareInfo, resolveDownloadUrl, downloadShare, sanitize } = require('./ucdrive');

console.log('✅ Module ucdrive.js loaded successfully');
console.log('✅ Exports tersedia:', {
  getShareInfo: typeof getShareInfo,
  resolveDownloadUrl: typeof resolveDownloadUrl,
  downloadShare: typeof downloadShare,
  sanitize: typeof sanitize,
});

// Test sanitize function (no API call needed)
console.log('\n--- Test sanitize() ---');
const testNames = [
  'video<test>.mp4',
  'foto:img|file?.jpg',
  'file with spaces.txt',
];
testNames.forEach(name => {
  console.log(`"${name}" → "${sanitize(name)}"`);
});

// Test actual API call (require share ID from user)
const shareId = process.argv[2];

if (!shareId) {
  console.log('\n⚠️  Untuk test actual API call, jalankan:');
  console.log('   UC_DRIVE_COOKIE="..." node test-ucdrive.js <SHARE_ID>');
  console.log('\n✅ Basic validation PASSED - no syntax errors!');
  process.exit(0);
}

// Test with real share ID
(async () => {
  try {
    console.log(`\n--- Test getShareInfo("${shareId}") ---`);
    const info = await getShareInfo(shareId);
    
    console.log('✅ Share info loaded:');
    console.log(`   Title: ${info.title}`);
    console.log(`   Total size: ${(info.totalSize / 1048576).toFixed(2)} MB`);
    console.log(`   Files: ${info.files.length}`);
    console.log(`   stoken: ${info.stoken.substring(0, 20)}...`);
    
    console.log('\n--- File list ---');
    info.files.forEach((f, i) => {
      const folder = f.folder ? `[${f.folder}] ` : '';
      console.log(`${i + 1}. ${folder}${f.name} (${(f.size / 1048576).toFixed(2)} MB)`);
    });
    
    console.log('\n✅ All tests PASSED!');
  } catch (err) {
    console.error('\n❌ Test FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
