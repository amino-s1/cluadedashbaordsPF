const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = require('docx');
const fs = require('fs');

const sections = [
  {
    tab: 'Overview',
    cards: [
      {
        title: 'Score Distribution',
        narrative: 'Shows how the 143 applicants are distributed across SIMAH credit-score bands (300 to 850+), broken down by acquisition outcome (Submitted, Approved, Booked, STP). This helps identify which score ranges drive the highest approval and booking rates, and whether marketing is attracting applicants in scorable, lendable bands.'
      },
      {
        title: 'Estimated DBR (from SIMAH)',
        narrative: 'Displays the Debt Burden Ratio distribution derived from SIMAH data — monthly obligations divided by declared income — segmented by acquisition outcome. It highlights how many applicants fall into high-DBR zones that typically trigger declines, helping calibrate affordability thresholds and pre-screening rules.'
      },
      {
        title: 'Risk Segmentation',
        narrative: 'Classifies the full portfolio into eight risk segments (Low/Medium/High Risk, No Score, Has Default, High Enquiry, BNPL Heavy, DBR > 50%) and shows the count, average score, approval rate, and booking rate for each. This gives a single-glance risk profile of the applicant pool and flags which segments are converting and which are not.'
      },
      {
        title: 'Enquiry Type Breakdown',
        narrative: 'Breaks down the total SIMAH enquiry volume by type — New Application, Score Only, Review, Final Enquiry, and Other — showing each type\'s share of total enquiries. This reveals whether applicants are being pulled primarily for new credit applications or for ancillary reasons like score checks and reviews.'
      },
      {
        title: 'Enquiry Trends per Institution',
        narrative: 'Ranks the top 20 institutions by total enquiry volume and shows year-over-year trends (2024, 2025, 2026) with a YoY percentage change and mini trend bars. This reveals which competitors are increasing or decreasing their pull activity on the same applicant pool, signaling shifts in market competition.'
      }
    ]
  },
  {
    tab: 'Enquiry Analysis',
    cards: [
      {
        title: 'Enquiries per Enquirer',
        narrative: 'Lists the top 25 institutions pulling enquiries on these applicants, showing total enquiry count, duration span in days, number of unique customers enquired, and how many of those were also submitted to UCFS. This identifies which competitors are most active on the same customer base and how deeply they overlap with UCFS submissions.'
      },
      {
        title: 'Shopping Intensity',
        narrative: 'Groups applicants by how many unique institutions pulled their SIMAH report (1–2, 3–5, 6–10, 11+), showing total customers and UCFS match rate per band. Heavy shoppers (6+ enquirers) typically have lower conversion — this chart quantifies that pattern and helps set thresholds for competitive pricing or fast-track offers.'
      },
      {
        title: 'Enquiries by Product Type',
        narrative: 'Shows horizontal bars ranking enquiry volume by product type (PLN, BNPL, Credit Card, Mortgage, etc.), filtered by the global filters. This reveals which financial products the applicant pool is most actively shopping for across the market, informing cross-sell opportunities and competitive positioning.'
      },
      {
        title: 'Enquiries by Type',
        narrative: 'Displays the distribution of enquiry types (New Application, Review, Score Only, etc.) as filtered horizontal bars. This complements the Overview breakdown by responding to the active filters, letting you isolate how enquiry-type patterns change by year, product, or enquiry type.'
      },
      {
        title: 'Monthly Enquiry Trend',
        narrative: 'A vertical bar chart showing total enquiry volume per month across the full date range of the dataset. This reveals seasonality, growth trends, and any spikes or dips in market activity that may correlate with campaigns, regulatory changes, or economic events.'
      }
    ]
  },
  {
    tab: 'Competitor & Loans',
    cards: [
      {
        title: 'Competitor Intelligence',
        narrative: 'A switchable table showing competitors either by total enquiry volume and market share ("By Enquiries") or by applicant-level conversion rates ("By Conversion" — approval % and booking %). This dual view lets you benchmark UCFS against the top 20 competitors on both activity intensity and outcome quality.'
      },
      {
        title: 'Avg Active Loan Amount',
        narrative: 'Compares the average active loan amount across the top 10 enquiring institutions against the UCFS booked average. This benchmarks UCFS loan sizes relative to competitors — a higher competitor average may indicate a different customer segment or product tier, while a lower one may signal pricing or limit opportunities.'
      },
      {
        title: 'Profit Rate per Institution',
        narrative: 'Calculates the annualized profit rate for each institution based on active PLN (Personal Loan) instruments only, using the formula: (Installment × Tenure − Loan Amount) / Loan Amount / (Tenure ÷ 12). Shows loan count, average instalment, tenure, total payment, loan amount, and the resulting rate — enabling direct pricing comparison across the market.'
      }
    ]
  },
  {
    tab: 'Risk & Utilization',
    cards: [
      {
        title: 'Credit Utilization Impact',
        narrative: 'Segments applicants by credit utilization band (0–20% through 81–100%+) and overlays acquisition match counts — how many CivilIDs matched, total acquisition rows, and how many were approved. This connects SIMAH-side credit behavior to UCFS acquisition outcomes, revealing which utilization levels correlate with approval.'
      },
      {
        title: 'Shopping Intensity vs Outcome',
        narrative: 'A stacked bar chart showing the 90-day enquiry intensity bands (0, 1–2, 3–5, 6–10, 11+) broken down by acquisition outcome (Submitted, Approved, Booked, STP). This directly measures how enquiry shopping volume impacts conversion — heavier shoppers typically show lower approval and booking rates.'
      },
      {
        title: 'Top SIMAH Score Reason Codes',
        narrative: 'Lists the 15 most frequent SIMAH score reason codes across all applicants, with count and percentage of reports. These codes explain why scores are depressed — common ones like "low credit limit" or "high enquiry volume" point to systemic issues that could be addressed through product design or pre-screening.'
      },
      {
        title: 'Decline Reasons by Score Band',
        narrative: 'Cross-references UCFS decline reasons against SIMAH score bands, showing the top 3 decline reasons within each band. This reveals whether declines are score-driven (low bands) or policy-driven (high bands declining for DBR or employer reasons), guiding where to adjust credit policy for better throughput.'
      }
    ]
  },
  {
    tab: 'Full Data',
    cards: [
      {
        title: 'Full Data Table',
        narrative: 'A filterable table of all 143 applicants showing Name, Civil ID, SIMAH Score, Income, Liabilities, DBR, Active Facilities, Enquiries, Defaults, BNPL count, and Outcome. Filters for Score band, Defaults, and UCFS match let you slice the population to investigate specific segments or individual cases.'
      }
    ]
  },
  {
    tab: 'UCFS Analysis',
    cards: [
      {
        title: 'UCFS KPIs',
        narrative: 'Summary statistics for the 74 applicants who matched between SIMAH and UCFS acquisition data — average score, median score, average DBR, average enquiries, default count, and approval/booking counts. This gives the headline risk profile of the subset that actually entered the UCFS funnel.'
      },
      {
        title: 'UCFS Applicants — Score Distribution',
        narrative: 'A vertical bar chart showing how the 74 UCFS-matched applicants distribute across score bands, color-coded by risk level. Compared to the full portfolio\'s score distribution, this reveals whether UCFS is attracting a better or worse credit-quality mix than the overall applicant pool.'
      },
      {
        title: 'UCFS Applicants — DBR Distribution',
        narrative: 'Shows the DBR distribution for UCFS-matched applicants only, using the same bands as the full portfolio. This isolates whether the UCFS funnel has a disproportionate share of high-DBR applicants compared to the broader pool, which would explain higher decline rates.'
      },
      {
        title: 'UCFS Applicants — Risk Segmentation',
        narrative: 'Applies the same risk segmentation framework (Low/Medium/High Risk, No Score, Has Default, DBR > 50%) to the 74 UCFS-matched applicants, showing count, percentage, average score, and approval/booking rates per segment. This pinpoints which risk segments are converting within the UCFS funnel specifically.'
      },
      {
        title: 'UCFS Applicants — Full List',
        narrative: 'A complete table of all 74 UCFS-matched applicants with Name, Civil ID, Score, Income, DBR, Enquiries, Outcome, Defaults, and BNPL count. This is the detailed reference for reviewing individual matched cases and cross-checking SIMAH profiles against acquisition decisions.'
      }
    ]
  },
  {
    tab: 'Applicant Profiles',
    cards: [
      {
        title: 'Applicant Profiles',
        narrative: 'Card-based view of all 143 applicants with search and filter tabs (All, Booked, Approved, Declined, STP). Each card shows score, 90-day enquiries, utilization, and DBR at a glance. Clicking a card opens a detailed modal with full acquisition record, SIMAH credit profile, score reason codes, and competitor pull history.'
      }
    ]
  }
];

async function generate() {
  const children = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: 'SIMAH Intelligence Dashboard', bold: true, size: 36, font: 'Calibri' })],
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Scorecard Narratives', size: 28, font: 'Calibri', color: '666666' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 }
  }));

  sections.forEach(section => {
    // Tab heading
    children.push(new Paragraph({
      children: [new TextRun({ text: section.tab, bold: true, size: 28, font: 'Calibri', color: '2563EB' })],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 300, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '2563EB' } }
    }));

    section.cards.forEach(card => {
      // Scorecard title
      children.push(new Paragraph({
        children: [
          new TextRun({ text: section.tab + ' > ', size: 20, font: 'Calibri', color: '999999' }),
          new TextRun({ text: card.title, bold: true, size: 22, font: 'Calibri' })
        ],
        spacing: { before: 200, after: 80 }
      }));
      // Narrative
      children.push(new Paragraph({
        children: [new TextRun({ text: card.narrative, size: 20, font: 'Calibri' })],
        spacing: { after: 200 }
      }));
    });
  });

  const doc = new Document({
    sections: [{ children }]
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = 'C:/Users/Emad.Ayyash/OneDrive - tasheelfinance/Documents/EIA Work/AI-Work/Analysis Agent/SIMAH_Intelligence_Scorecard_Narratives.docx';
  fs.writeFileSync(outPath, buffer);
  console.log('Created: ' + outPath);
}

generate().catch(e => { console.error(e); process.exit(1); });
