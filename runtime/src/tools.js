/**
 * The seven WebMCP tools of the Office of Kaiju Affairs.
 *
 * Every tool maps to a real citizen task. There is no tool here that exists to
 * pad the list — the budget is seven and we spend all of it on questions a
 * person actually walks into an agency office to ask.
 */

import { result, failure, normalizePath, absolute, clamp } from './util.js';
import { searchPages } from './search.js';
import { evaluate } from './rules.js';
import { prefill } from './form.js';

const MAX_RESULTS = 25;

/**
 * @param {{ getManifest: () => Promise<any>, currentPath: () => string }} ctx
 */
export function createTools(ctx) {
  const { getManifest, currentPath } = ctx;

  return [
    {
      name: 'search_site',
      title: 'Search the Office of Kaiju Affairs',
      description:
        'Search every page of this site by keyword and get ranked results with a summary, a snippet and the exact URL. Use this first when you do not know which page holds an answer — it searches the full published page index, including pages that are several clicks deep in the navigation.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for, in plain words. e.g. "fee waiver for repeat damage claims"' },
          limit: { type: 'integer', description: 'Maximum results to return (1-25).', default: 5, minimum: 1, maximum: MAX_RESULTS },
          section: { type: 'string', description: 'Optional: restrict to one site section, e.g. "claims", "permits", "evacuation".' }
        },
        required: ['query']
      },
      async execute({ query, limit, section }) {
        const manifest = await getManifest();
        const results = searchPages(manifest, { query, limit: clamp(limit ?? 5, 1, MAX_RESULTS), section });
        if (!results.length) {
          return result(
            { ok: true, query, results: [], sections: [...new Set(manifest.pages.map((p) => p.section).filter(Boolean))] },
            `No pages matched "${query}". Available sections: ${[...new Set(manifest.pages.map((p) => p.section).filter(Boolean))].join(', ')}.`
          );
        }
        const text = results
          .map((r, i) => `${i + 1}. ${r.title} — ${absolute(r.path)}\n   ${r.snippet || r.summary}`)
          .join('\n');
        return result({ ok: true, query, count: results.length, results }, text);
      }
    },

    {
      name: 'get_page_summary',
      title: 'Read a page as structured data',
      description:
        'Return the plain-language summary, key facts, headings and outbound links for one page of this site, without fetching or scraping its HTML. Pass the path from a search result.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Page path or full URL, e.g. "/claims/fee-waivers/". Defaults to the page currently open.' }
        }
      },
      async execute({ path }) {
        const manifest = await getManifest();
        const target = path || currentPath();
        const page = manifest.page(target);
        if (!page) {
          return failure(
            `No page in the index matches "${target}".`,
            'Call search_site first and use the "path" value from a result.'
          );
        }
        const facts = (page.keyFacts || []).map((f) => `- ${f.label}: ${f.value}`).join('\n');
        const text = [
          `${page.title} (${absolute(page.path)})`,
          page.summary || '',
          facts ? `\nKey facts:\n${facts}` : '',
          page.headings?.length ? `\nSections: ${page.headings.map((h) => h.text).join(' · ')}` : ''
        ].filter(Boolean).join('\n');
        return result(
          {
            ok: true,
            page: {
              id: page.id || null,
              path: normalizePath(page.path),
              url: absolute(page.path),
              title: page.title,
              section: page.section || null,
              breadcrumb: page.breadcrumb || [],
              summary: page.summary || '',
              keyFacts: page.keyFacts || [],
              headings: page.headings || [],
              relatedPaths: page.links?.internal || [],
              serviceIds: page.serviceIds || [],
              updated: page.updated || null
            }
          },
          text
        );
      }
    },

    {
      name: 'list_services',
      title: 'List what this agency can do for you',
      description:
        'Enumerate every service the Office of Kaiju Affairs offers — permits, claims, evacuation support — with a one-line description and the page where each one starts. Use this when you do not yet know what is possible here.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional filter, e.g. "permits", "claims", "safety".' }
        }
      },
      async execute({ category }) {
        const manifest = await getManifest();
        const services = manifest.services
          .filter((s) => !category || String(s.category || '').toLowerCase() === String(category).toLowerCase())
          .map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category || null,
            summary: s.summary || '',
            entryUrl: absolute(s.entryPath),
            entryPath: normalizePath(s.entryPath),
            hasEligibilityCheck: Boolean(s.eligibilityRulesetId),
            hasOnlineForm: Boolean(s.formId)
          }));
        if (!services.length) {
          return failure(
            category ? `No services in category "${category}".` : 'No services are published in the manifest.',
            `Known categories: ${[...new Set(manifest.services.map((s) => s.category).filter(Boolean))].join(', ')}`
          );
        }
        const text = services
          .map((s) => `- ${s.name} [${s.id}] — ${s.summary}\n  Start here: ${s.entryUrl}`)
          .join('\n');
        return result({ ok: true, count: services.length, services }, text);
      }
    },

    {
      name: 'get_service_requirements',
      title: 'What do I need to bring?',
      description:
        'Return the documents, form fields, fees, deadlines and processing time for one service, as structured data. Pass the service id from list_services (a service name also works).',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'Service id from list_services, e.g. "kaiju-proximity-permit".' }
        },
        required: ['serviceId']
      },
      async execute({ serviceId }) {
        const manifest = await getManifest();
        const service = manifest.service(serviceId);
        if (!service) {
          return failure(
            `No service matches "${serviceId}".`,
            `Known service ids: ${manifest.services.map((s) => s.id).join(', ')}`
          );
        }
        const req = service.requirements || {};
        const docs = (req.documents || []).map((d) => `- ${d.name}${d.required === false ? ' (optional)' : ''}${d.description ? ` — ${d.description}` : ''}`).join('\n');
        const fees = (req.fees || []).map((f) => `- ${f.label}: ${f.amount === 0 ? 'no charge' : `${f.currency || ''}${f.amount}`}${f.waivable ? ' (waivable)' : ''}`).join('\n');
        const text = [
          `${service.name} — requirements`,
          docs ? `\nDocuments:\n${docs}` : '',
          fees ? `\nFees:\n${fees}` : '',
          req.processingTime ? `\nProcessing time: ${req.processingTime}` : '',
          req.sourcePath ? `\nSource: ${absolute(req.sourcePath)}` : ''
        ].filter(Boolean).join('\n');
        return result(
          {
            ok: true,
            serviceId: service.id,
            name: service.name,
            documents: req.documents || [],
            fields: req.fields || [],
            fees: req.fees || [],
            deadlines: req.deadlines || [],
            processingTime: req.processingTime || null,
            eligibilityRulesetId: service.eligibilityRulesetId || null,
            formId: service.formId || null,
            sourceUrl: req.sourcePath ? absolute(req.sourcePath) : absolute(service.entryPath)
          },
          text
        );
      }
    },

    {
      name: 'check_eligibility',
      title: 'Check eligibility against the published rules',
      description:
        'Evaluate a person\'s situation against this agency\'s published eligibility rules and return the outcome, any fee waivers granted, the documents they will need, a citation to the page that states each rule, and — for anything NOT granted — the requirement that was not met, so you can tell the person what would change the answer. Call with no answers first to receive the list of questions to ask. The answers are never stored or transmitted — they are evaluated in the page.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'Service to check, e.g. "damage-compensation". Either this or rulesetId.' },
          rulesetId: { type: 'string', description: 'Ruleset id, if you already have one from a previous call.' },
          answers: {
            type: 'object',
            description: 'Answers keyed by question id, e.g. {"incidentsLast12Months": 2, "zone": "4"}. Omit to get the question list.',
            additionalProperties: true
          }
        }
      },
      async execute({ serviceId, rulesetId, answers }) {
        const manifest = await getManifest();
        const ruleset = rulesetId
          ? manifest.ruleset(rulesetId)
          : manifest.rulesetForService(manifest.service(serviceId)?.id);

        if (!ruleset) {
          const available = manifest.eligibility.map((r) => `${r.id} (service: ${r.serviceId})`).join(', ');
          return failure(
            `No eligibility ruleset for "${serviceId || rulesetId}".`,
            available ? `Available rulesets: ${available}` : 'This site publishes no eligibility rules.'
          );
        }

        if (!answers || !Object.keys(answers).length) {
          const questions = (ruleset.questions || []).map((q) => ({
            id: q.id, label: q.label, type: q.type, required: q.required !== false, options: q.options || undefined
          }));
          return result(
            { ok: true, rulesetId: ruleset.id, needsAnswers: true, questions },
            `To determine eligibility, answer these and call check_eligibility again with an "answers" object:\n` +
              questions.map((q) => `- ${q.id} (${q.type}${q.options ? `: ${q.options.join(' | ')}` : ''}) — ${q.label}`).join('\n')
          );
        }

        const outcome = evaluate(ruleset, answers);
        const text = [
          `Outcome: ${outcome.outcome}${outcome.determined ? '' : ' (provisional — some answers are missing)'}`,
          outcome.grants.length ? `Granted: ${outcome.grants.join(', ')}` : '',
          outcome.requiredDocuments.length ? `Documents needed: ${outcome.requiredDocuments.join(', ')}` : '',
          outcome.missingAnswers.length ? `Still needed: ${outcome.missingAnswers.map((m) => m.id).join(', ')}` : '',
          outcome.matchedRules.length ? `\nRules applied:\n${outcome.matchedRules.map((r) => `- ${r.description || r.id}${r.citation ? ` (${absolute(r.citation.path)}${r.citation.anchor || ''})` : ''}`).join('\n')}` : '',
          outcome.unmetRules?.length
            ? `\nNot granted, and what each would need:\n${outcome.unmetRules.map((r) =>
                `- ${r.wouldGrant.join(', ') || r.id}: ${r.requirement}. Yours: ${Object.entries(r.yourAnswers).map(([k, v]) => `${k}=${v ?? 'not answered'}`).join(', ')}.` +
                `${r.description ? ` ${r.description}` : ''}${r.citation ? ` (${absolute(r.citation.path)}${r.citation.anchor || ''})` : ''}`).join('\n')}`
            : ''
        ].filter(Boolean).join('\n');
        return result({ ok: true, ...outcome }, text);
      }
    },

    {
      name: 'prefill_permit_form',
      title: 'Fill in the form (the person submits it)',
      description:
        'Fill the visible fields of the application form on the current page and report exactly what was entered, what was rejected, and which declared fields were left empty because no value was supplied. This tool never submits: the person reviews the highlighted fields and presses the button themselves. Call get_service_requirements first to learn the field names.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          formId: { type: 'string', description: 'Form id from get_service_requirements. Defaults to the form on the current page.' },
          values: {
            type: 'object',
            description: 'Field values keyed by field name, e.g. {"applicantName": "Mira Tanaka", "zone": "4"}.',
            additionalProperties: true
          }
        },
        required: ['values']
      },
      async execute({ formId, values }) {
        const manifest = await getManifest();
        const here = currentPath();
        const descriptor = formId ? manifest.form(formId) : manifest.formsForPath(here)[0];

        if (!descriptor) {
          const elsewhere = manifest.forms.map((f) => `${f.id} → ${absolute(f.path)}`).join('\n');
          return failure(
            formId ? `No form named "${formId}".` : `There is no form on ${here}.`,
            elsewhere ? `Forms published on this site:\n${elsewhere}\nOpen that page, then call this tool again.` : undefined
          );
        }
        if (normalizePath(descriptor.path) !== here) {
          return failure(
            `The form "${descriptor.id}" is on a different page.`,
            `Navigate to ${absolute(descriptor.path)} and call prefill_permit_form again — a page can only fill its own form.`
          );
        }

        const report = prefill(descriptor, values);
        if (!report.ok) return failure(report.error, 'The page may still be loading. Try again once the form is visible.');

        const text = [
          `Filled ${report.filled.length} field(s) on ${descriptor.id}:`,
          ...report.filled.map((f) => `  ${f.label}: ${f.value}`),
          report.rejected.length ? `\nNot filled:\n${report.rejected.map((r) => `  ${r.name} — ${r.reason}`).join('\n')}` : '',
          report.notProvided?.length ? `\nLeft empty because no value was supplied:\n${report.notProvided.map((f) => `  ${f.label} (${f.name}) — optional, but supply it if it applies`).join('\n')}` : '',
          `\n${report.humanAction}`
        ].filter(Boolean).join('\n');
        return result(report, text);
      }
    },

    {
      name: 'get_office_info',
      title: 'Find your regional office and evacuation route',
      description:
        'Look up the regional Kaiju Affairs office, its address, hours and contact details, plus the evacuation routes and assembly points for an area. Filter by evacuation zone, region name, or a free-text place name.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Evacuation zone, e.g. "4".' },
          region: { type: 'string', description: 'Region name, e.g. "Kanto North".' },
          officeId: { type: 'string', description: 'Exact office id, if known.' },
          query: { type: 'string', description: 'Free-text place name to match against region, address or served zones.' }
        }
      },
      async execute({ zone, region, officeId, query }) {
        const manifest = await getManifest();
        let offices = manifest.offices;

        if (officeId) offices = offices.filter((o) => String(o.id) === String(officeId));
        if (zone) offices = offices.filter((o) => (o.zones || []).map(String).includes(String(zone)));
        if (region) offices = offices.filter((o) => String(o.region || '').toLowerCase().includes(String(region).toLowerCase()));
        if (query) {
          const q = String(query).toLowerCase();
          offices = offices.filter((o) =>
            [o.name, o.region, o.address, ...(o.zones || [])].join(' ').toLowerCase().includes(q)
          );
        }

        if (!offices.length) {
          return failure(
            'No office matches those filters.',
            `Published offices: ${manifest.offices.map((o) => `${o.name} (zones ${(o.zones || []).join('/')})`).join('; ')}`
          );
        }

        const shaped = offices.map((o) => ({
          id: o.id,
          name: o.name,
          region: o.region || null,
          address: o.address || null,
          hours: o.hours || null,
          phone: o.phone || null,
          email: o.email || null,
          zones: o.zones || [],
          servicesOffered: o.servicesOffered || [],
          evacuationRoutes: (o.evacuationRoutes || []).map((r) => ({
            id: r.id, name: r.name, zones: r.zones || [], description: r.description || '',
            assemblyPoint: r.assemblyPoint || null, url: r.path ? absolute(r.path) : null
          })),
          url: o.path ? absolute(o.path) : null
        }));

        const text = shaped
          .map((o) => [
            `${o.name} — ${o.region}`,
            o.address ? `  ${o.address}` : '',
            o.hours ? `  Hours: ${o.hours}` : '',
            o.phone ? `  Phone: ${o.phone}` : '',
            o.zones.length ? `  Serves zones: ${o.zones.join(', ')}` : '',
            ...o.evacuationRoutes.map((r) => `  Route ${r.name}: ${r.description}${r.assemblyPoint ? ` Assembly point: ${r.assemblyPoint}.` : ''}`)
          ].filter(Boolean).join('\n'))
          .join('\n\n');

        return result({ ok: true, count: shaped.length, offices: shaped }, text);
      }
    }
  ];
}
