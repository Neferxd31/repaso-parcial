import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const model = 'gemini-3.5-flash-lite';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const materialDir = path.resolve('material');
const allTopics = 'all';
const quoteSchema = {
  type: 'string',
  description:
    'Una sola frase continua copiada textualmente del material, de 8 a 30 palabras, que respalda la pregunta y su respuesta correcta. Sin puntos suspensivos ni fragmentos unidos.',
};

const schemas = {
  open: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      question: { type: 'string' },
      quote: quoteSchema,
    },
    required: ['topic', 'question', 'quote'],
  },
  mcq: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      question: { type: 'string' },
      quote: quoteSchema,
      options: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['text', 'explanation'],
        },
      },
      correctIndex: { type: 'integer' },
    },
    required: ['topic', 'question', 'quote', 'options', 'correctIndex'],
  },
  grade: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['Incorrecta', 'Superficial', 'Parcial', 'Sólida'] },
      feedback: { type: 'string' },
      missing: { type: 'string' },
      modelAnswer: { type: 'string' },
    },
    required: ['level', 'feedback', 'missing', 'modelAnswer'],
  },
};

function avoidRepeats(asked) {
  if (asked.length === 0) return '';
  return `\n\nYa se hicieron estas preguntas. No las repitas ni las reformules, y prioriza temas distintos:\n- ${asked.join('\n- ')}`;
}

const prompts = {
  open: ({ asked }) =>
    'Genera una pregunta abierta sobre el material. Debe pedir explicar, comparar o relacionar conceptos, no solo recordar un dato. "topic" es el tema del material del que sale.' +
    avoidRepeats(asked),
  mcq: ({ asked }) =>
    'Genera una pregunta de opción múltiple con exactamente 4 opciones y una sola correcta; los distractores deben ser plausibles. ' +
    'En "explanation" de la opción correcta explica por qué es correcta con un breve resumen del concepto. ' +
    'En "explanation" de cada opción incorrecta explica por qué está mal y corrige la idea errónea. ' +
    'No empieces las explicaciones con "Correcto" o "Incorrecto". "correctIndex" es la posición (0 a 3) de la correcta. "topic" es el tema del material del que sale.' +
    avoidRepeats(asked),
  grade: ({ question, answer }) =>
    `Evalúa la respuesta de la estudiante a esta pregunta abierta, comparándola con el material.\n\nPregunta: ${question}\n\nRespuesta de la estudiante: ${answer}\n\n` +
    'Niveles para "level": Incorrecta (errores conceptuales o no responde la pregunta), Superficial (idea general correcta pero sin desarrollo ni conceptos clave), ' +
    'Parcial (correcta pero incompleta: faltan puntos importantes), Sólida (completa, precisa y bien explicada). ' +
    '"feedback": qué hizo bien y qué está mal, dirigido a ella. "missing": qué le faltó para una respuesta sólida (vacío si nada). "modelAnswer": una respuesta sólida de referencia.',
};

// Cada .md de material/ es una sección; su id es el nombre del archivo y su título, el primer encabezado "# ...".
async function listTopics() {
  const files = (await readdir(materialDir)).filter((file) => file.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(materialDir, file), 'utf8');
      const title = content.match(/^# (.+)$/m)?.[1] ?? file;
      return { id: file.replace(/\.md$/, ''), title, content };
    }),
  );
}

async function loadMaterial(topic) {
  const topics = await listTopics();
  if (topic === allTopics) return topics.map((item) => item.content).join('\n\n');
  return topics.find((item) => item.id === topic)?.content;
}

// La cita se compara sin mayúsculas, signos ni markdown, para no rechazar diferencias de formato.
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// El modelo a veces une dos trozos reales del material ("A... B"). Se acepta la cita si casi todas sus
// palabras forman tramos de 4 o más palabras que existen tal cual en el material; una paráfrasis no pasa.
const minRunWords = 4;
const minCoverage = 0.9;

function longestRunAt(words, start, material) {
  let end = start;
  // Los espacios alrededor evitan que un tramo coincida con un pedazo de otra palabra.
  while (end < words.length && material.includes(` ${words.slice(start, end + 1).join(' ')} `)) end++;
  return end - start;
}

function quoteIsInMaterial(quote, material) {
  const words = normalize(quote).split(' ');
  if (words.length < 5) return false;

  const normalizedMaterial = ` ${normalize(material)} `;
  let covered = 0;
  for (let index = 0; index < words.length; ) {
    const run = longestRunAt(words, index, normalizedMaterial);
    if (run >= minRunWords) covered += run;
    index += Math.max(run, 1);
  }
  return covered / words.length >= minCoverage;
}

// Gemini tiende a poner la correcta en las primeras posiciones; se baraja para que no sea predecible.
function shuffleOptions(quiz) {
  const correct = quiz.options[quiz.correctIndex];
  const options = [...quiz.options].sort(() => Math.random() - 0.5);
  return { ...quiz, options, correctIndex: options.indexOf(correct) };
}

// La saturación (503) suele durar segundos; se reintenta antes de mostrarle un error a la estudiante.
async function askGemini(body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (response.status !== 503 || attempt === 3) return response;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function friendlyError(status, error) {
  if (status === 429) return 'Se alcanzó el límite de uso de Gemini. Espera un minuto (o hasta mañana si fue el límite diario).';
  if (status === 503) return 'El modelo está saturado en este momento. Intenta de nuevo en unos segundos.';
  return `Error de Gemini: ${error.message}`;
}

async function generate(type, material, prompt) {
  const system =
    'Eres un tutor que ayuda a una estudiante a preparar un parcial. Usa exclusivamente el material de abajo; no agregues información que no esté en él. ' +
    'Si el material marca un dato como discrepancia o dice que no se pregunte, no hagas preguntas sobre ese dato. ' +
    'Escribe en español, en texto plano sin markdown, de forma clara y cercana, sin saludos.\n\n=== MATERIAL ===\n' +
    material;

  const response = await askGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Al evaluar se baja la temperatura para que la misma respuesta reciba la misma nota.
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schemas[type],
      ...(type === 'grade' && { temperature: 0.2 }),
    },
  });
  const data = await response.json();
  if (data.error) return { status: response.status, error: friendlyError(response.status, data.error) };

  const text = data.candidates[0].content.parts.filter((part) => !part.thought).map((part) => part.text).join('');
  return { result: JSON.parse(text), tokens: data.usageMetadata.totalTokenCount };
}

export default async (req) => {
  const { type, topic = allTopics, asked = [], question, answer } = await req.json();
  if (type === 'topics') {
    const topics = await listTopics();
    return Response.json({ topics: topics.map(({ id, title }) => ({ id, title })) });
  }
  if (!schemas[type]) return Response.json({ error: 'Tipo de solicitud inválido.' }, { status: 400 });

  const material = await loadMaterial(topic);
  if (!material) return Response.json({ error: 'La sección elegida no existe.' }, { status: 400 });

  const prompt = prompts[type]({ asked, question, answer });
  // Una pregunta cuya cita no aparece en el material probablemente fue inventada: se descarta y se pide otra una vez.
  let tokens = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { result, tokens: used, status, error } = await generate(type, material, prompt);
    if (error) return Response.json({ error, tokens }, { status });

    // tokens: la página lo usa para calcular cuánto esperar antes de la siguiente consulta.
    tokens += used;
    if (type === 'grade') return Response.json({ ...result, tokens });
    if (!quoteIsInMaterial(result.quote, material)) continue;
    return Response.json(type === 'mcq' ? shuffleOptions({ ...result, tokens }) : { ...result, tokens });
  }
  return Response.json({ error: 'No se pudo generar una pregunta verificada contra el material. Intenta de nuevo.', tokens }, { status: 502 });
};

export const config = { path: '/api/quiz' };
