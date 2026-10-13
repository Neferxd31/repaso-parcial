import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// El segundo modelo es de respaldo: tiene su propio cupo y suele seguir disponible cuando el principal se satura.
// (gemini-3.5-flash no sirve de respaldo: su cupo gratuito es de solo 20 solicitudes al día.)
const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
// Netlify corta la función a los 10 s; se deja margen para responder antes de ese límite.
const budgetMs = 9000;
const fallbackAfterMs = 3500;
const minTimeForRetryMs = 4000;
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callModel(model, body, signal) {
  const response = await fetch(`${baseUrl}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(data.error.message), { status: response.status });
  return data;
}

// Gemini a veces tarda más de un minuto o responde 503 por saturación. Si un modelo falla o no contesta
// a tiempo, se lanza el siguiente en paralelo y se usa la primera respuesta que llegue.
async function askGemini(body, deadline) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 0));
  const errors = [];
  let answered = false;

  const launch = (index) => {
    if (answered || index >= models.length) return Promise.reject(new Error('No quedan modelos de respaldo.'));
    const call = callModel(models[index], body, controller.signal).then(
      (data) => {
        answered = true;
        return data;
      },
      (error) => {
        errors.push(error);
        throw error;
      },
    );
    const next = Promise.race([wait(fallbackAfterMs), call.catch(() => {})]).then(() => launch(index + 1));
    return Promise.any([call, next]);
  };

  try {
    return await launch(0);
  } catch {
    // Solo se informa el límite de uso si todos los modelos lo alcanzaron; si no, es saturación y la página reintenta.
    const allLimited = errors.length === models.length && errors.every((error) => error.status === 429);
    throw allLimited ? errors[0] : (errors.find((error) => error.status !== 429) ?? errors[0]);
  } finally {
    clearTimeout(timer);
    // Cancela la solicitud que haya quedado pendiente.
    controller.abort();
  }
}

function friendlyError(error) {
  if (error.status === 429) return 'Se alcanzó el límite de uso de Gemini. Espera un minuto (o hasta mañana si fue el límite diario).';
  if (error.status === 503 || error.name === 'AbortError') return 'Gemini está saturado en este momento. Intenta de nuevo en unos segundos.';
  return `Error de Gemini: ${error.message}`;
}

async function generate(type, material, prompt, deadline) {
  const system =
    'Eres un tutor que ayuda a una estudiante a preparar un parcial. Usa exclusivamente el material de abajo; no agregues información que no esté en él. ' +
    'Si el material marca un dato como discrepancia o dice que no se pregunte, no hagas preguntas sobre ese dato. ' +
    'Escribe en español, en texto plano sin markdown, de forma clara y cercana, sin saludos.\n\n=== MATERIAL ===\n' +
    material;

  let data;
  try {
    data = await askGemini(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Al evaluar se baja la temperatura para que la misma respuesta reciba la misma nota.
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schemas[type],
          ...(type === 'grade' && { temperature: 0.2 }),
        },
      },
      deadline,
    );
  } catch (error) {
    return { status: error.status === 429 ? 429 : 503, error: friendlyError(error) };
  }

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
  const deadline = Date.now() + budgetMs;
  // Una pregunta cuya cita no aparece en el material probablemente fue inventada: se descarta y, si queda
  // tiempo, se pide otra. Si no, la página reintenta con una nueva llamada.
  let tokens = 0;
  do {
    const { result, tokens: used, status, error } = await generate(type, material, prompt, deadline);
    if (error) return Response.json({ error, tokens }, { status });

    // tokens: la página lo usa para calcular cuánto esperar antes de la siguiente consulta.
    tokens += used;
    if (type === 'grade') return Response.json({ ...result, tokens });
    if (quoteIsInMaterial(result.quote, material)) {
      return Response.json(type === 'mcq' ? shuffleOptions({ ...result, tokens }) : { ...result, tokens });
    }
  } while (deadline - Date.now() > minTimeForRetryMs);
  return Response.json({ error: 'No se pudo generar una pregunta verificada contra el material. Intenta de nuevo.', tokens }, { status: 503 });
};

export const config = { path: '/api/quiz' };
