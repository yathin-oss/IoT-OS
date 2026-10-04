import { z } from 'zod';
import { DEPENDENCY_ECOSYSTEMS } from '../project/schema';
import { LANGUAGES } from '../registry/types';

/**
 * Schemas for structured AI responses. LLM output is never trusted: every
 * structured response is parsed against one of these, then checked against the
 * registry and the hardware validation engine before the user sees a proposal.
 */

/** "led1.A" or "board.GPIO25" */
const endpointString = z.string().regex(/^[A-Za-z][\w-]*\.[\w+/-]+$/, 'endpoint must look like "component.PIN" or "board.PIN"');

const filePath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/') && !p.includes('..') && !p.startsWith('.iotos') && !/^[a-zA-Z]:/.test(p), 'must be a safe project-relative path');

export const CodeEditResponseSchema = z.object({
  summary: z.string().min(1).max(4000),
  edits: z.array(z.object({ path: filePath, content: z.string().max(200_000) })).max(12),
  notes: z.array(z.string().max(1000)).max(20).default([]),
});
export type CodeEditResponse = z.infer<typeof CodeEditResponseSchema>;

export const DebugAnalysisSchema = z.object({
  summary: z.string().min(1).max(4000),
  observations: z.array(z.string().max(1000)).max(30).default([]),
  likelyCauses: z
    .array(
      z.object({
        cause: z.string().max(1000),
        confidence: z.enum(['high', 'medium', 'low']),
        evidence: z.string().max(1000).default(''),
      }),
    )
    .max(10)
    .default([]),
  assumptions: z.array(z.string().max(1000)).max(20).default([]),
  suggestedFixes: z.array(z.string().max(1500)).max(10).default([]),
  edits: z.array(z.object({ path: filePath, content: z.string().max(200_000) })).max(8).default([]),
});
export type DebugAnalysis = z.infer<typeof DebugAnalysisSchema>;

const ComponentSpecSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'component ids are lowercase identifiers like led1')
    .max(32)
    .refine((s) => s !== 'board', '"board" is reserved'),
  type: z.string().min(1),
  label: z.string().max(40).optional(),
  props: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  reason: z.string().max(500).optional(),
});

const ConnectionSchema = z.object({ from: endpointString, to: endpointString });

export const CircuitPlanSchema = z.object({
  summary: z.string().max(2000),
  components: z.array(ComponentSpecSchema).max(30),
  connections: z.array(ConnectionSchema).max(120),
  /** Components (by id) to remove from the existing circuit. */
  remove: z.array(z.string()).max(30).default([]),
  wifi: z.boolean().optional(),
  notes: z.array(z.string().max(1000)).max(20).default([]),
});
export type CircuitPlan = z.infer<typeof CircuitPlanSchema>;

export const ProjectPlanSchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().max(2000),
  requirements: z.array(z.string().max(500)).max(30),
  language: z.enum(LANGUAGES),
  board: z.object({ id: z.string(), reason: z.string().max(1000) }),
  wifi: z.boolean().default(false),
  bluetooth: z.boolean().default(false),
  components: z.array(ComponentSpecSchema).max(30),
  connections: z.array(ConnectionSchema).max(120),
  firmware: z.object({ files: z.array(z.object({ path: filePath, content: z.string().max(200_000) })).min(1).max(10) }),
  dependencies: z.array(z.object({ ecosystem: z.enum(DEPENDENCY_ECOSYSTEMS), name: z.string(), version: z.string().optional() })).max(20).default([]),
  overview: z.string().max(6000).default(''),
  assumptions: z.array(z.string().max(1000)).max(20).default([]),
});
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;
