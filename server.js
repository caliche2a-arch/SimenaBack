const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@libsql/client');
const { PrismaLibSql } = require('@prisma/adapter-libsql');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
process.env.DATABASE_URL = process.env.TURSO_DATABASE_URL;

const prisma = new PrismaClient({ 
  adapter: new PrismaLibSql({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
});
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey123';

app.use(cors({
  origin: '*', // For testing, you might want to restrict this later to your Vercel URL
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Simena Backend is running' });
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado.' });
    req.user = user;
    next();
  });
};

// Middleware to check payment status
const checkPaymentStatus = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || !user.pago) {
      return res.status(403).json({ 
        error: 'Acceso restringido.', 
        message: 'Debes completar el pago para acceder a los prompts premium.' 
      });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Error al verificar estado de pago.' });
  }
};

// --- AUTH ROUTES ---

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, experienceLevel } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        pago: false, // Por defecto no han pagado
        experienceLevel: experienceLevel || 'bajo'
      }
    });

    res.status(201).json({ message: 'Usuario registrado con éxito', userId: user.id });
  } catch (error) {
    res.status(400).json({ error: 'El email ya está registrado o datos inválidos.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Contraseña incorrecta.' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ 
      token, 
      user: { id: user.id, name: user.name, email: user.email, pago: user.pago, experienceLevel: user.experienceLevel } 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en el servidor.' });
  }
});

// --- PROMPT ROUTES ---

// Public list (filtered by experience level)
app.get('/api/prompts/list', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const targetLevel = user.experienceLevel === 'intermedio' ? 'Secundaria' : 'Primaria';

    const prompts = await prisma.prompt.findMany({
      where: { level: targetLevel },
      select: { id: true, title: true, subject: true, level: true, category: true }
    });
    res.json(prompts);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching prompts' });
  }
});

// Protected content (requires payment)
app.get('/api/prompts/content/:id', authenticateToken, checkPaymentStatus, async (req, res) => {
  const { id } = req.params;
  const prompt = await prisma.prompt.findUnique({
    where: { id: parseInt(id) }
  });

  if (!prompt) return res.status(404).json({ error: 'Prompt no encontrado.' });
  res.json(prompt);
});

// Prompt Reviewer
app.post('/api/prompts/review', authenticateToken, async (req, res) => {
  const { promptText, manualIntent } = req.body;
  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'El prompt no puede estar vacío.' });
  }

  const lowerPrompt = promptText.toLowerCase();
  let adviceList = [];
  let intent = 'general';

  // --- Detección de intención ---
  if (lowerPrompt.match(/(carta|comunicado|mensaje|circular|correo|citación|nota)/)) intent = 'comunicacion';
  else if (lowerPrompt.match(/(plan|clase|planeación|sesión|secuencia|unidad)/)) intent = 'planeacion';
  else if (lowerPrompt.match(/(examen|quiz|prueba|evaluación|icfes|saber|test)/)) intent = 'examen';
  else if (lowerPrompt.match(/(rúbrica|criterios|calificar|matriz)/)) intent = 'rubrica';
  else if (lowerPrompt.match(/(inclusión|nee|discapacidad|autismo|tdah|dislexia|piar|dua)/)) intent = 'inclusion';
  else if (lowerPrompt.match(/(convivencia|disciplina|bullying|acoso|conflicto|comportamiento)/)) intent = 'convivencia';
  else if (lowerPrompt.match(/(reunión|acta|comité|asamblea|padres)/)) intent = 'reunion';
  else if (lowerPrompt.match(/(proyecto|abp)/)) intent = 'proyecto';
  else if (lowerPrompt.match(/(explica|resumen|teoría|concepto)/)) intent = 'explicacion';
  else if (lowerPrompt.match(/(taller|guía|guia|hoja de trabajo|ficha|ejercicio|práctica|practica|actividad)/)) intent = 'tarea_o_guia';

  // Si el usuario eligió una categoría manualmente, tiene prioridad
  if (manualIntent && manualIntent !== 'auto') intent = manualIntent;

  // --- Extracción de contexto del texto del usuario ---
  const gradeMatch = lowerPrompt.match(/(preescolar|kinder|primero|segundo|tercero|cuarto|quinto|sexto|séptimo|septimo|octavo|noveno|décimo|decimo|undécimo|undecimo|\d+\s*°?\s*(grado|°))/i);
  const extractedGrade = gradeMatch ? gradeMatch[0].trim() : '[Escribe el grado, ej. Quinto de Primaria]';

  const subjectMatch = lowerPrompt.match(/(matemáticas|matematicas|ciencias|español|espanol|lenguaje|sociales|inglés|ingles|física|fisica|química|quimica|biología|biologia|historia|arte|educación física|tecnología)/i);
  const extractedSubject = subjectMatch ? subjectMatch[0].trim() : '[Escribe la materia, ej. Matemáticas]';

  const userTopic = promptText.trim();
  let improvedPrompt = '';

  switch (intent) {
    case 'comunicacion':
      adviceList.push('👥 ¿A quién va dirigido? Dile a la IA si es para los papás, los estudiantes o la rectoría.');
      adviceList.push('📋 ¿Cuál es el motivo? Sé específico: ¿una citación, una circular informativa, una felicitación?');
      adviceList.push('🗣️ ¿Qué tono quieres? Por ejemplo: amable y cercano, o formal e institucional.');
      improvedPrompt = `Actúa como un [Cargo: ej. Coordinador / Docente Titular] experto en Comunicación Asertiva Escolar. Redacta una [carta/circular/comunicado] oficial sobre: "${userTopic}".

Variables del Contexto:
- Destinatarios: [Padres de familia / Estudiantes / Rectoría].
- Institución: [Nombre de tu Colegio].
- Tono Requerido: [Ej. Formal e institucional / Amable y motivador].

Instrucciones:
1. Estructura de 3 partes: Saludo cordial, Exposición clara del motivo, Llamado a la acción.
2. Si es una situación difícil, enfócate en la colaboración Familia-Escuela.
3. Deja espacios con corchetes [ ] para fechas, horas y nombres específicos.`;
      break;

    case 'planeacion':
      adviceList.push(`📚 Grado detectado: "${extractedGrade}". Si no es correcto, corrígelo en el prompt.`);
      adviceList.push(`📖 Materia detectada: "${extractedSubject}". Confirma o corrige en el prompt.`);
      adviceList.push('🎯 ¿Qué quieres que aprendan? Escribe el objetivo: qué sabrá o podrá hacer el estudiante al final.');
      improvedPrompt = `Actúa como un Asesor Curricular. Diseña una Secuencia Didáctica completa.

Variables del Contexto:
- Grado/Edad: ${extractedGrade}.
- Área/Materia: ${extractedSubject}.
- Tema Central: "${userTopic}".
- Duración Total: [ej. 2 horas / 1 sesión de 45 min].
- Objetivo de Aprendizaje: [Qué sabrá o podrá hacer el estudiante al final].

Estructura (usa formato Tabla):
1. Exploración (Saberes Previos): Actividad o pregunta para activar conocimientos.
2. Estructuración (Conceptualización): Cómo explicarás el tema sin clase 100% magistral.
3. Práctica (Ejecución): Actividad donde el estudiante aplica lo aprendido.
4. Cierre (Evaluación): Pregunta reflexiva de salida para verificar el aprendizaje.
5. Materiales e Inclusión: Recursos y adaptación para diferentes ritmos de aprendizaje.`;
      break;

    case 'examen':
      adviceList.push(`📝 Grado detectado: "${extractedGrade}". ¿Es correcto? Ajústalo si es necesario.`);
      adviceList.push('🧠 Pide preguntas de diferentes dificultades: algunas de memoria (fácil) y otras de análisis (difícil).');
      adviceList.push('📄 Solicita también la hoja de respuestas del docente con la clave de corrección.');
      improvedPrompt = `Actúa como un Especialista en Evaluación Educativa. Diseña una prueba escrita sobre: "${userTopic}".

Variables de Evaluación:
- Nivel de los Estudiantes: ${extractedGrade}.
- Materia: ${extractedSubject}.
- Cantidad de Preguntas: [ej. 10 preguntas].

Instrucciones:
1. Genera [Número] preguntas de Selección Múltiple usando situaciones de la vida real (no preguntas directas de memoria).
2. Genera [Número] preguntas Abiertas de análisis y reflexión.
3. Presenta el resultado en DOS documentos:
   - CUADERNILLO DEL ESTUDIANTE (solo las preguntas).
   - GUÍA DEL DOCENTE (clave de respuestas + rúbrica para las preguntas abiertas).`;
      break;

    case 'rubrica':
      adviceList.push('📊 Dile cuántas dimensiones quieres evaluar (ej. "evalúa 4 aspectos: contenido, presentación, equipo y creatividad").');
      adviceList.push('⭐ Pide los niveles de calificación de tu institución (Bajo, Básico, Alto, Superior).');
      adviceList.push('📋 Solicita que la entregue en formato de tabla para imprimir y usar en clase.');
      improvedPrompt = `Actúa como un Experto en Evaluación Educativa. Crea una Rúbrica en formato de Tabla para: "${userTopic}".

Variables:
- Nivel Educativo: ${extractedGrade}.
- Dimensiones a Evaluar: [ej. Contenido, Presentación, Trabajo en Equipo, Creatividad].
- Niveles de Desempeño: Superior, Alto, Básico, Bajo.

Instrucciones:
1. Para cada dimensión y nivel, escribe QUÉ HACE exactamente el estudiante (evidencias observables).
2. Agrega una columna con el porcentaje de peso de cada dimensión (que sumen 100%).`;
      break;

    case 'inclusion':
      adviceList.push('♿ Especifica la condición del estudiante (TDAH, Autismo, Dislexia...) para que la IA ajuste correctamente.');
      adviceList.push('👁️ Pide materiales visuales y concretos — son los más efectivos para la mayoría de necesidades especiales.');
      adviceList.push('✅ Solicita alternativas para que el estudiante demuestre que aprendió sin un examen tradicional.');
      improvedPrompt = `Actúa como un Educador Especial experto en inclusión educativa.

Necesito adaptar el siguiente tema para un estudiante con necesidades especiales: "${userTopic}".

Contexto de Inclusión:
- Perfil del Estudiante: [Edad] años, diagnosticado con [Condición, ej. TDAH, Autismo nivel 1, Dislexia].
- Grado: ${extractedGrade}.
- Contexto del Aula: [Aula regular con aproximadamente 30 estudiantes].

Dame un plan con 3 secciones:
1. ¿Cómo presento la información? (visual, auditiva o con movimiento).
2. ¿Cómo puede demostrar que aprendió? (3 alternativas al examen escrito tradicional).
3. ¿Cómo lo motivo? (estrategias para mantener su atención y confianza durante la clase).`;
      break;

    case 'convivencia':
      adviceList.push('⚠️ Describe qué pasó: quiénes están involucrados, cuándo ocurrió y si ya hubo una intervención previa.');
      adviceList.push('🤝 Pide un enfoque que busque soluciones, no solo castigos.');
      adviceList.push('👪 Solicita también cómo comunicarle la situación a los padres de manera adecuada.');
      improvedPrompt = `Actúa como un Orientador Escolar y Experto en Resolución de Conflictos.

Tengo la siguiente situación en mi institución: "${userTopic}".

Variables del Caso:
- Edades de los involucrados: [ej. 13 y 14 años].
- Gravedad aproximada: [Conflicto leve / Agresión verbal / Agresión física / Situación de acoso].

Dame un plan de acción con:
1. Pasos a seguir inmediatamente (antes de llamar a los padres).
2. Guion de mediación: cómo hablar con los estudiantes usando escucha activa y sin señalar culpables.
3. Cómo comunicarle la situación a los padres sin generar más conflicto.
4. Una actividad preventiva para el grupo que evite que esto se repita.`;
      break;

    case 'reunion':
      adviceList.push('🕐 ¿Cuánto tiempo tienes para la reunión? Eso define cómo organizar el tiempo.');
      adviceList.push('🎯 ¿Cuál es el mensaje más importante que quieres que se lleven los asistentes?');
      adviceList.push('📝 Pide que genere también el ACTA para registrar los acuerdos y compromisos.');
      improvedPrompt = `Actúa como un Facilitador de Reuniones Educativas. Diseña la agenda y el acta para: "${userTopic}".

Variables:
- Tipo de Reunión: [ej. Entrega de Boletines / Escuela de Padres / Comité de Área].
- Tiempo disponible: [ej. 60 minutos].
- Objetivo principal: [Qué mensaje debe quedar claro al terminar].

Genera:
1. Agenda Minuto a Minuto con tiempos estrictos (Bienvenida, Tema principal, Preguntas, Compromisos, Cierre).
2. Guion de apertura para crear un ambiente de colaboración.
3. Plantilla de Acta con columnas: Acuerdo, Responsable y Fecha límite.`;
      break;

    case 'proyecto':
      adviceList.push('🎯 ¿Cuál es el producto final? (maqueta, presentación, video, experimento, feria...).');
      adviceList.push('📅 ¿Cuánto tiempo tienen? Sé específico con las semanas o sesiones disponibles.');
      adviceList.push('📚 ¿Qué materias se pueden conectar? Un buen proyecto integra al menos 2 materias.');
      improvedPrompt = `Actúa como un Diseñador Curricular experto en Aprendizaje Basado en Proyectos (ABP).

Necesito diseñar un proyecto para: "${userTopic}".

Variables del Proyecto:
- Grado: ${extractedGrade}.
- Materias que se conectan: [ej. Ciencias, Matemáticas y Lenguaje].
- Duración estimada: [ej. 3 semanas].
- Producto Final: [Qué construirán los estudiantes, ej. maqueta, video, feria].

Estructura del Proyecto:
1. Pregunta Orientadora: Un desafío abierto y motivador del mundo real.
2. Fases del Proyecto: Investigación → Desarrollo → Presentación Pública.
3. Cronograma semana a semana.
4. Cómo evaluar: Rúbrica con criterios de trabajo en equipo, investigación y presentación.`;
      break;

    case 'explicacion':
      adviceList.push('🎣 Pide que empiece con algo que les llame la atención (un misterio o un dato curioso).');
      adviceList.push('🌍 Pide que use ejemplos de la vida real de los estudiantes (deportes, redes sociales, su ciudad).');
      adviceList.push('✏️ Al final, pide una pregunta de cierre para verificar si entendieron.');
      improvedPrompt = `Actúa como un Profesor y Divulgador Pedagógico excepcional. Tu objetivo es explicar: "${userTopic}".

Instrucciones:
- Público objetivo: Estudiantes de ${extractedGrade} que suelen aburrirse con explicaciones tradicionales.
- Hook (Enganche): Inicia con un misterio, paradoja o dato increíble de la vida real.
- Conexión con su mundo: Usa una metáfora o ejemplo vinculado a su vida cotidiana.
- Desglose: Divide el tema en 3 puntos concretos, del más fácil al más complejo.
- Verificación: Termina con una pregunta reflexiva que el estudiante responda antes de salir.`;
      break;

    case 'tarea_o_guia':
      adviceList.push(`📚 Grado detectado: "${extractedGrade}". ¿Es correcto? Ajústalo en el prompt.`);
      adviceList.push('⏱️ ¿Cuánto tiempo tienen los estudiantes para resolver la guía?');
      adviceList.push('🖨️ Pide que el formato sea imprimible: texto claro, espacios para escribir.');
      improvedPrompt = `Actúa como un Diseñador de Materiales Educativos. Crea una guía/taller de trabajo sobre: "${userTopic}".

Variables:
- Grado: ${extractedGrade}.
- Materia: ${extractedSubject}.
- Tiempo estimado de resolución: [ej. 30 minutos en clase / Tarea para casa].
- Modalidad: [Individual / En parejas / En grupos].

Estructura de la guía:
1. Introducción breve (2-3 líneas sobre el propósito).
2. Conceptos clave (resumen o mapa de ideas).
3. Ejercicios guiados (con ejemplo resuelto).
4. Ejercicios independientes (para que el estudiante los resuelva solo).
5. Pregunta de reflexión final (¿para qué sirve esto en la vida real?).
Formato: Apto para imprimir en hoja carta, con espacios para que el estudiante escriba.`;
      break;

    default: {
      const words = promptText.split(' ').length;
      if (words < 8) {
        adviceList.push('📝 Tu mensaje es muy corto. Intenta agregar más detalles sobre lo que necesitas.');
      }
      adviceList.push('👤 Dile a la IA quién eres: "Actúa como si fuera un docente de [materia] en [grado]..."');
      adviceList.push('🎯 Describe qué quieres: ¿una explicación, un examen, una guía, una carta, un plan de clase?');
      adviceList.push('👦 Menciona para quién es: grado, edades aproximadas y algo especial del grupo.');
      improvedPrompt = `Actúa como un Docente Experto en ${extractedSubject}.

Necesito que me ayudes con lo siguiente: "${userTopic}".

Para que la respuesta sea útil en mi salón, ten en cuenta este contexto:
- Grado y edades: ${extractedGrade}.
- Materia: ${extractedSubject}.
- ¿Qué quiero lograr?: [Describe el objetivo, ej. que los estudiantes entiendan, practiquen o creen algo].
- Características del grupo: [ej. Son muy activos, tienen dificultades de lectura, es un grupo avanzado].

Entrega la respuesta en formato [Párrafos / Lista numerada / Tabla] con un lenguaje que los estudiantes puedan entender fácilmente.`;
    }
  }

  const intentLabels = {
    comunicacion: 'Redacción de Comunicado Oficial',
    planeacion: 'Plan de Clase / Secuencia Didáctica',
    examen: 'Diseño de Evaluación / Prueba',
    rubrica: 'Rúbrica de Evaluación',
    inclusion: 'Estrategia de Inclusión Educativa',
    convivencia: 'Manejo de Convivencia / Conflicto',
    reunion: 'Organización de Reunión Escolar',
    proyecto: 'Diseño de Proyecto Pedagógico (ABP)',
    explicacion: 'Explicación Pedagógica de Concepto',
    tarea_o_guia: 'Guía / Taller de Trabajo',
    general: 'Solicitud General Educativa'
  };

  const finalAdvice = `Aquí tienes 3 consejos para que tu prompt funcione aún mejor:\n\n${adviceList.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;

  try {
    await prisma.promptLog.create({
      data: {
        originalText: promptText,
        detectedIntent: intent,
        improvedPrompt: improvedPrompt,
        userId: req.user ? req.user.id : null
      }
    });
  } catch (err) {
    console.error("Error guardando el log del prompt:", err);
  }

  res.json({
    advice: finalAdvice,
    improvedPrompt,
    detectedIntent: intent,
    detectedIntentLabel: intentLabels[intent] || 'Solicitud General'
  });
});

// Admin/System route to toggle payment (for testing)
app.post('/api/users/toggle-payment', authenticateToken, async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { pago: true }
  });
  res.json({ message: 'Estado de pago actualizado', pago: user.pago });
});

app.listen(PORT, () => {
  console.log(`Servidor Simena corriendo en http://localhost:${PORT}`);
});
