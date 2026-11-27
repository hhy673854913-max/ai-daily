// LangChain 问答链
//
// LCEL 组装：检索文档格式化 → ChatPromptTemplate → ChatOpenAI → StrOutputParser。
// 系统提示词是回答门禁的一部分：只允许依据给定资料作答，资料不足必须明说，
// 禁止编造；引用必须落到编号对应的简报条目上。
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { RunnableSequence } = require('@langchain/core/runnables');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { ChatOpenAI } = require('@langchain/openai');

const SYSTEM_TEMPLATE = [
  '你是《AI 日报》的档案问答助手，基于检索到的历史简报片段回答用户问题。必须遵守：',
  '1. 仅依据给定资料作答，不要引入资料外的信息、数字或观点；',
  '2. 资料不足以回答问题（或只有模糊相关）时，明确回答"历史简报中没有足够的信息"，禁止编造；',
  '3. 引用处标注片段编号，如 [1][2]，编号必须对应给定资料；',
  '4. 用简体中文作答，先给结论，再补关键依据，控制在 300 字以内；',
  '5. 若资料之间存在矛盾，指出矛盾而不是自行取舍。',
  '',
  '资料片段：',
  '{context}',
].join('\n');

// 检索文档 → 带编号的资料文本（编号与引用一一对应）
function formatDocs(docs) {
  return docs.map((d, i) => {
    const m = d.metadata || {};
    const head = `[${i + 1}] ${m.day || ''}《${m.title || ''}》` +
      `${m.source ? '（' + m.source + '）' : ''}${m.stars != null ? ' ★' + m.stars + '/5' : ''}`;
    return `${head}\n${d.pageContent}`;
  }).join('\n\n---\n\n');
}

// 环境变量配好 LLM 时返回可执行链，否则返回 null（调用方走摘录式降级回答）
function createChain(env = process.env) {
  const key = env.LLM_API_KEY || '';
  if (!key) return null;
  const llm = new ChatOpenAI({
    apiKey: key,
    model: env.LLM_MODEL || 'gpt-4o-mini',
    configuration: { baseURL: env.LLM_BASE_URL },
    temperature: 0.2,
    maxRetries: 2,
  });
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', SYSTEM_TEMPLATE],
    ['human', '{question}'],
  ]);
  return RunnableSequence.from([prompt, llm, new StringOutputParser()]);
}

async function runChain(chain, question, docs) {
  return chain.invoke({ context: formatDocs(docs), question });
}

// 无 LLM 时的降级回答：摘录最相关的简报条目（仍带引用），不生成新文本
function extractiveAnswer(docs) {
  const lines = docs.map((d, i) => {
    const m = d.metadata || {};
    const score = m.score != null ? `（相关度 ${m.score.toFixed(2)}）` : '';
    return `[${i + 1}] ${m.day || ''}《${m.title || ''}》${score}\n${d.pageContent.split('\n').slice(1).join('\n')}`;
  });
  return '（未配置 LLM，以下为检索到的原始简报摘录）\n\n' + lines.join('\n\n---\n\n');
}

module.exports = { createChain, runChain, formatDocs, extractiveAnswer, SYSTEM_TEMPLATE };
