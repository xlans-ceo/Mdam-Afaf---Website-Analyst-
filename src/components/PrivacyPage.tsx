import React from 'react';
import { ShieldCheck, ArrowRight, ExternalLink } from 'lucide-react';
import { DEVELOPER_CONTACT } from '../config/limits';

export const PrivacyPage: React.FC<{ onBackHome?: () => void; onBack?: () => void }> = ({
  onBackHome,
  onBack
}) => {
  const handleBack = onBack || onBackHome;
  return (
    <div className="max-w-[760px] mx-auto px-4 py-8 space-y-6">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleBack}
            aria-label="الرجوع للرئيسية"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-alt)] cursor-pointer"
          >
            <ArrowRight className="w-5 h-5 rtl:rotate-0 ltr:rotate-180" />
          </button>
          <div>
            <h1 className="text-[24px] font-bold text-[var(--ink)]">سياسة الخصوصية</h1>
            <p className="text-[13px] text-[var(--pen)] font-bold">مسودة، تحتاج مراجعة قانونية</p>
          </div>
        </div>
        <div className="w-10 h-10 rounded-full bg-[var(--primary)] text-[var(--on-primary)] font-bold text-[18px] flex items-center justify-center">
          ع
        </div>
      </header>

      <div className="space-y-4 text-[15px] leading-[1.7] text-[var(--ink)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-5 sm:p-6 shadow-[var(--sh-1)]">
        <section className="space-y-2">
          <h2 className="text-[18px] font-bold text-[var(--ink)]">1. إيه اللي بنخزنه؟</h2>
          <p>
            بنخزن تقارير الفحص الفنية العامة للمواقع المفحوصة، ومعرّف رقمي مشفر غير قابل للعكس للزائر (Hashed Visitor ID) لإدارة الحصة اليومية وحماية الخدمة من الاستخدام المفرط، وتقييمات الرضا (النجوم والملاحظات الاختيارية).
          </p>
          <p className="font-bold text-[var(--primary)]">
            مش بنطلب تسجيل دخول، ومش بنخزن بيانات شخصية أو كلمات سر أو بطاقات بنكية.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-[18px] font-bold text-[var(--ink)]">2. مدة الاحتفاظ بالبيانات</h2>
          <ul className="list-disc list-inside space-y-1 text-[var(--ink-muted)]">
            <li><strong className="text-[var(--ink)]">تقارير الفحص:</strong> بتتحذف تلقائياً بعد مرور 30 يوماً من تاريخ الفحص.</li>
            <li><strong className="text-[var(--ink)]">نصوص الملاحظات والآراء:</strong> بتتحفظ لمدة 30 يوماً لأغراض التدقيق الفني ثم تُمسح.</li>
            <li><strong className="text-[var(--ink)]">الإحصائيات المجمعة المجهولة:</strong> بتتحفظ لحد 12 شهر لمتابعة دقة القواعد ونسب الرضا بدون أي رابط بهوية الزائر.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-[18px] font-bold text-[var(--ink)]">3. خدمات الطرف الثالث</h2>
          <p>
            عشان نقيس السرعة ونحلل البيانات، بنتواصل مع:
          </p>
          <ul className="list-disc list-inside space-y-1 text-[var(--ink-muted)]">
            <li><strong className="text-[var(--ink)]">Google PageSpeed Insights:</strong> لقياس أداء الموبايل المعملي وسرعة استجابة السيرفر عبر رابط الصفحة العام.</li>
            <li><strong className="text-[var(--ink)]">Google Gemini (الذكاء الاصطناعي):</strong> لإعادة صياغة الشروحات الفنية بالعربي الدارج بدون إرسال أي أسرار أو بيانات مستخدمين.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-[18px] font-bold text-[var(--ink)]">4. طبيعة الفحص والمسؤولية</h2>
          <p>
            فحص مدام عفاف هو مراجعة آلية استرشادية لعينة من صفحات الموقع العامة (حتى 10 صفحات) لمساعدة أصحاب المواقع في معرفة جاهزية مواقعهم، والنتائج لا تشكل ضماناً شاملاً ولا تمثل إقراراً بالامتثال القانوني لأي جهة تنظيمية.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-[18px] font-bold text-[var(--ink)]">5. طلبات مسح البيانات والتواصل</h2>
          <p>
            تقدر تمسح تقريرك في أي وقت من زرار «مسح التقرير» داخل شاشة الفحص. لأي استفسارات أو طلبات مسح إضافية، التواصل مباشرة مع المطور عبر LinkedIn:
          </p>
          <a
            href="https://www.linkedin.com/in/mo7amadsultan/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-sm)] border border-[var(--primary)] text-[var(--primary)] font-bold text-[14px] hover:bg-[var(--surface-alt)]"
          >
            <span>LinkedIn ({DEVELOPER_CONTACT.DEVELOPER_NAME_AR})</span>
            <ExternalLink className="w-4 h-4" />
          </a>
        </section>
      </div>
    </div>
  );
};
