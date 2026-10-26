/**
 * Feedback Report CLI Script (B4.4)
 * Runs `npm run feedback:report`
 */
import { persistentStore } from '../src/lib/storage';

function run() {
  console.log('=====================================================');
  console.log('       تقرير تقييمات وملاحظات مدام عفاف (Admin)       ');
  console.log('=====================================================\n');

  const overview = persistentStore.getAdminFeedbackOverview();

  console.log(`إجمالي تقييمات التقارير: ${overview.totalReportRatings}`);
  console.log(`متوسط النجوم: ${overview.averageStars} / 5\n`);

  console.log('توزيع النجوم:');
  for (let s = 5; s >= 1; s--) {
    const count = overview.ratingDistribution[s] || 0;
    const bar = '★'.repeat(s) + ' '.repeat(5 - s) + ' | ' + '#'.repeat(count);
    console.log(`  ${s} نجوم: ${count.toString().padStart(3, ' ')} ${bar}`);
  }

  if (overview.topReasons.length > 0) {
    console.log('\nأبرز أسباب التقييم:');
    for (const r of overview.topReasons) {
      console.log(`  - ${r.reason}: ${r.count}`);
    }
  }

  console.log('\nإحصائيات القواعد والملاحظات:');
  if (overview.ruleStats.length === 0) {
    console.log('  لا توجد أصوات مسجلة على الملاحظات حتى الآن.');
  } else {
    for (const r of overview.ruleStats) {
      const agree = r.totalVotes >= 10 ? `${(r.agreementRatio * 100).toFixed(0)}%` : 'أقل من 10 أصوات';
      const flagNote = r.flagged ? ' ⚠️ [ملاحظات سلبية متكررة 3+ زوار]' : '';
      console.log(`  - [${r.ruleId}] إجمالي: ${r.totalVotes} (👍 ${r.upVotes} / 👎 ${r.downVotes}) — توافق: ${agree}${flagNote}`);
    }
  }

  if (overview.recentComments.length > 0) {
    console.log('\nأحدث التعليقات (منقحة لحماية الخصوصية):');
    for (const c of overview.recentComments.slice(0, 10)) {
      console.log(`  [${c.domain} - ${c.stars}★]: "${c.commentRedacted}" (${c.createdAt.slice(0, 10)})`);
    }
  }

  console.log('\n=====================================================');
}

run();
