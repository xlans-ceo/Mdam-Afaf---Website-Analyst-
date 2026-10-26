import React from 'react';

interface TermsPageProps {
  onBack?: () => void;
}

export const TermsPage: React.FC<TermsPageProps> = ({ onBack }) => {
  return (
    <div className="min-h-screen py-10 px-4 md:px-8 max-w-4xl mx-auto" dir="rtl" style={{ color: 'var(--ink)' }}>
      {/* Draft banner */}
      <div
        className="p-4 mb-8 text-sm font-medium rounded-md border flex items-center gap-3"
        style={{
          background: 'var(--sev-medium-bg)',
          borderColor: 'var(--sev-medium-fg)',
          color: 'var(--sev-medium-fg)',
          borderRadius: 'var(--r-md)'
        }}
      >
        <span className="text-xl">⚠️</span>
        <div>
          <strong className="block text-base font-bold">مسودة، تحتاج مراجعة قانونية</strong>
          هذه الشروط هي مسودة استرشادية لتنظيم استخدام أداة مدام عفاف في مرحلة الإطلاق التجريبي (Alpha).
        </div>
      </div>

      {/* Header */}
      <header className="mb-8 border-b pb-6" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-lg shadow-sm"
              style={{ background: 'var(--primary)' }}
            >
              ع
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
                شروط استخدام <span style={{ textDecoration: 'underline', textDecorationColor: 'var(--pen)', textDecorationThickness: '3px' }}>مدام عفاف</span>
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--ink-muted)' }}>
                نسخة تجريبية استرشادية — آخر تحديث: أكتوبر 2026
              </p>
            </div>
          </div>

          {onBack && (
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm font-medium rounded-md transition-colors border"
              style={{
                background: 'var(--surface)',
                borderColor: 'var(--border)',
                color: 'var(--ink)',
                borderRadius: 'var(--r-md)'
              }}
            >
              ← العودة للفحص
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="space-y-6 text-sm leading-relaxed">
        {/* Section 1 */}
        <section
          className="p-6 rounded-lg border bg-white"
          style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}
        >
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--primary)' }}>
            <span>١.</span> طبيعة الخدمة والتقييم الاسترشادي
          </h2>
          <p className="mb-3">
            أداة "مدام عفاف" هي أداة تدقيق وفحص فني آلي مستقل للمواقع الإلكترونية. الفحص يعتمد على <strong>عينة بحد أقصى 10 صفحات عامة</strong> من الموقع المدخل.
          </p>
          <p className="mb-3">
            التقارير والملاحظات الصادرة عن الأداة هي <strong>لأغراض استرشادية فنية فقط</strong>، ولا تمثل بأي شكل من الأشكال:
          </p>
          <ul className="list-disc list-inside space-y-1 pr-2" style={{ color: 'var(--ink-muted)' }}>
            <li>شهادة ضمان خلو الموقع من العيوب أو الثغرات الأمنية بنسبة 100%.</li>
            <li>إقراراً بالامتثال القانوني لأي تشريعات محلية أو دولية (مثل اللائحة العامة لحماية البيانات GDPR أو أنظمة التجارة الإلكترونية).</li>
            <li>استشارة قانونية أو استثمارية معتمدة.</li>
          </ul>
        </section>

        {/* Section 2 */}
        <section
          className="p-6 rounded-lg border bg-white"
          style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}
        >
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--primary)' }}>
            <span>٢.</span> إذن ومسؤولية فحص المواقع
          </h2>
          <p className="mb-2">
            باستخدامك للأداة، تقر وتتعهد بأنك:
          </p>
          <ul className="list-disc list-inside space-y-1 pr-2" style={{ color: 'var(--ink-muted)' }}>
            <li>إما المالك الرسمي أو المفوض بإدارة الموقع الإلكتروني الذي تقوم بإدخال رابطه، أو تمتلك إذناً صريحاً من مالكه لمراجعته.</li>
            <li>لن تستخدم الأداة لأغراض الإضرار بخوادم الآخرين، أو حجب الخدمة، أو الفحص العشوائي غير المصرح به.</li>
            <li>تتفهم أن روبوت الفحص يرسل طلبات HTTP عادية للصفحات العامة المتاحة للجميع مع احترام ملف <code dir="ltr" className="px-1.5 py-0.5 rounded bg-gray-100">robots.txt</code>.</li>
          </ul>
        </section>

        {/* Section 3 */}
        <section
          className="p-6 rounded-lg border bg-white"
          style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}
        >
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--primary)' }}>
            <span>٣.</span> حدود المسؤولية
          </h2>
          <p className="mb-3">
            يتم تقديم الخدمة "كما هي" دون أي ضمانات صريحة أو ضمنية. نحن لا نتحمل مسؤولية أي أضرار مباشرة أو غير مباشرة ناتجة عن:
          </p>
          <ul className="list-disc list-inside space-y-1 pr-2" style={{ color: 'var(--ink-muted)' }}>
            <li>القرارات البرمجية أو التقنية المعتمدة بناءً على التوصيات أو برومبتات الذكاء الاصطناعي المقترحة.</li>
            <li>أي انقطاع مؤقت في الخدمة أو تعذر الوصول إلى الخوادم المفحوصة بسبب جدران الحماية أو آليات مكافحة البوتات.</li>
            <li>فقدان أو عدم اكتمال البيانات في الفحوصات الجزئية (مثل تطبيقات الصفحة الواحدة SPA غير المعروضة بالكامل).</li>
          </ul>
        </section>

        {/* Section 4 */}
        <section
          className="p-6 rounded-lg border bg-white"
          style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}
        >
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--primary)' }}>
            <span>٤.</span> الاستخدام المقبول وسياسة القفل
          </h2>
          <p className="mb-2">
            للحفاظ على جودة الخدمة لجميع المستخدمين، يتم تطبيق قيود استخدام آلية تشمل:
          </p>
          <ul className="list-disc list-inside space-y-1 pr-2" style={{ color: 'var(--ink-muted)' }}>
            <li>قفل نطاق الفحص لمدة 10 ساعات للزائر بعد أول فحص ناجح لمنع إساءة الاستخدام.</li>
            <li>حد أقصى 5 فحوصات لنفس النطاق خلال نافذة القفل.</li>
            <li>حظر عناوين IP الخاصة والشبكات الداخلية وشبكات البيانات الوصفية للسحاب منعاً لهجمات SSRF.</li>
          </ul>
        </section>

        {/* Section 5 */}
        <section
          className="p-6 rounded-lg border bg-white"
          style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-1)' }}
        >
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--primary)' }}>
            <span>٥.</span> التواصل والاستفسارات
          </h2>
          <p className="mb-3">
            إذا كان لديك أي استفسار حول هذه الشروط أو ترغب في تقديم طلب إزالة تقرير أو مراجعة مخصصة، يمكنك التواصل مباشرة مع المطور المسؤول عبر حسابه في LinkedIn:
          </p>
          <div className="pt-2">
            <a
              href="https://www.linkedin.com/in/mo7amadsultan/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 font-medium text-white rounded-md transition-opacity hover:opacity-90"
              style={{ background: 'var(--primary)', borderRadius: 'var(--r-md)' }}
            >
              <span>🔗</span>
              <span>تواصل مع المطور على LinkedIn</span>
              <span dir="ltr" className="text-xs opacity-80">(mo7amadsultan)</span>
            </a>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t text-center text-xs" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
        مدام عفاف — مراجعة مواقع بالدليل والبرهان • نسخة تجريبية (Alpha)
      </footer>
    </div>
  );
};
