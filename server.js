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

app.use(cors());
app.use(express.json());

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
  const { promptText } = req.body;
  if (!promptText || promptText.trim() === '') {
    return res.status(400).json({ error: 'El prompt no puede estar vacío.' });
  }

  // --- ANÁLISIS DE INTENCIÓN Y VARIABLES FALTANTES ---
  const lowerPrompt = promptText.toLowerCase();
  let adviceList = [];
  let intent = 'general';
  
  if (lowerPrompt.match(/(carta|comunicado|mensaje|circular|correo|citación|nota)/)) {
    intent = 'comunicacion';
  } else if (lowerPrompt.match(/(plan|clase|planeación|sesión|secuencia|unidad)/)) {
    intent = 'planeacion';
  } else if (lowerPrompt.match(/(examen|quiz|prueba|evaluación|icfes|saber|test)/)) {
    intent = 'examen';
  } else if (lowerPrompt.match(/(rúbrica|criterios|calificar|matriz)/)) {
    intent = 'rubrica';
  } else if (lowerPrompt.match(/(inclusión|nee|discapacidad|autismo|tdah|dislexia|piar|dua)/)) {
    intent = 'inclusion';
  } else if (lowerPrompt.match(/(convivencia|disciplina|bullying|acoso|conflicto|comportamiento)/)) {
    intent = 'convivencia';
  } else if (lowerPrompt.match(/(reunión|acta|comité|asamblea|padres)/)) {
    intent = 'reunion';
  } else if (lowerPrompt.match(/(proyecto|abp|actividad|dinámica|juego|feria)/)) {
    intent = 'proyecto';
  } else if (lowerPrompt.match(/(explica|resumen|teoría|concepto)/)) {
    intent = 'explicacion';
  }

  // --- CONSTRUCCIÓN DEL MEJOR PROMPT Y CONSEJOS ---
  let improvedPrompt = '';
  
  switch(intent) {
    case 'comunicacion':
      adviceList.push('Especifica el **Público Objetivo** (Padres de familia, Docentes, Estudiantes, Rectoría).');
      adviceList.push('Indica el **Propósito Formal** (Citación disciplinaria, Circular informativa, Felicitación, Reporte académico).');
      adviceList.push('Define el **Tono Comunicativo** (Asertivo, Empático, Estrictamente institucional, Motivador).');
      improvedPrompt = `Actúa como un [Cargo: ej. Coordinador de Convivencia / Docente Titular] experto en Comunicación Asertiva Escolar. Redacta una [carta/circular/comunicado] oficial.

Variables del Contexto:
- Destinatarios: [Público Objetivo].
- Institución: [Nombre de tu Colegio/Instituto].
- Asunto/Motivo: [Describe el motivo central, ej. citación por bajo rendimiento o invitación a feria de ciencias].
- Tono Requerido: [Tono, ej. Firme pero empático, apegado al manual de convivencia].

Instrucciones Pedagógicas:
1. Usa una estructura de 3 partes: Saludo cordial e institucional, Exposición clara del motivo (sin rodeos ni juicios de valor), y Llamado a la acción (Call to Action).
2. Si es una situación disciplinaria o académica negativa, usa un enfoque de "Disciplina Positiva", enfocándote en la colaboración Familia-Escuela.
3. Deja espacios con corchetes [ ] para que el maestro llene datos como fechas, horas y nombres de estudiantes.`;
      break;

    case 'planeacion':
      adviceList.push('Menciona el **Modelo Pedagógico** (Constructivismo, Escuela Nueva, Tradicional).');
      adviceList.push('Alinea tu clase con los **DBA (Derechos Básicos de Aprendizaje)** o estándares de competencia de tu país.');
      adviceList.push('Establece los **Momentos de la Clase** (Exploración, Estructuración, Práctica, Transferencia).');
      improvedPrompt = `Actúa como un Asesor Curricular y Experto en Planeación Educativa. Diseña una Secuencia Didáctica completa basada en enfoques constructivistas.

Variables del Contexto:
- Grado/Edad: [Grado escolar, ej. 5to de Primaria].
- Área/Materia: [Asignatura].
- Tema Central: "${promptText.trim()}".
- Duración Total: [ej. 2 horas reloj].
- Estándar/Competencia (DBA): [Menciona el Derecho Básico de Aprendizaje o competencia a alcanzar].

Estructura Obligatoria de Salida (Usa formato Tabla):
1. **Fase de Exploración (Saberes Previos)**: Actividad "Rompehielo" cognitiva o pregunta problematizadora.
2. **Fase de Estructuración (Conceptualización)**: Cómo el docente entregará el contenido (evitando la clase 100% magistral).
3. **Fase de Práctica (Ejecución)**: Actividad donde el estudiante aplica lo aprendido (guiado).
4. **Fase de Transferencia (Cierre/Evaluación)**: Cómo evaluamos formativamente que se logró el objetivo y su conexión con la vida real.
5. **Materiales e Inclusión**: Recursos necesarios y una nota sobre cómo adaptar la clase (DUA) para diferentes ritmos de aprendizaje.`;
      break;

    case 'examen':
      adviceList.push('Utiliza la **Taxonomía de Bloom** para asegurar preguntas de diferentes niveles cognitivos (Recordar, Analizar, Crear).');
      adviceList.push('Indica si quieres formato estandarizado tipo **Pruebas Saber / ICFES** (Preguntas contextualizadas con único enunciado).');
      adviceList.push('Pide a la IA que genere la "Hoja de Claves" o Rúbrica por separado.');
      improvedPrompt = `Actúa como un Especialista en Psicometría y Evaluación Educativa (creador de pruebas tipo ICFES/Saber o College Board).

Diseña una prueba escrita sobre: "${promptText.trim()}".

Variables de Evaluación:
- Nivel de los Estudiantes: [Grado o Nivel Cognitivo].
- Cantidad de Preguntas: [ej. 10 preguntas].
- Marco Teórico: Alinea las preguntas usando la Taxonomía de Bloom.

Instrucciones Estrictas:
1. Genera [Número] preguntas de Opción Múltiple con Única Respuesta (OMUR). En lugar de preguntas directas ("¿Qué es X?"), usa **Enunciados Contextualizados** (casos, problemas, lectura corta previa) para evaluar la "Competencia" y no solo la memoria.
2. Genera [Número] preguntas Abiertas de Alto Nivel Cognitivo (Analizar, Evaluar, Crear).
3. Separa el resultado en dos documentos Markdown: 
   - El CUADERNILLO DEL ESTUDIANTE.
   - La GUÍA DEL DOCENTE (con la clave de respuestas, justificación de por qué la respuesta correcta lo es, y una rúbrica cualitativa para las preguntas abiertas).`;
      break;

    case 'inclusion':
      adviceList.push('Especifica el tipo de **Necesidad Educativa Especial (NEE)** (TEA, TDAH, Dislexia, Discapacidad Cognitiva).');
      adviceList.push('Menciona los principios del **DUA (Diseño Universal para el Aprendizaje)**.');
      adviceList.push('Pide estrategias de **Ajustes Razonables (PIAR)**.');
      improvedPrompt = `Actúa como un Educador Especial y Experto en Diseño Universal para el Aprendizaje (DUA).

Necesito adaptar un material, clase o evaluación sobre el siguiente tema: "${promptText.trim()}".

Contexto de Inclusión:
- Perfil del Estudiante: Estudiante de [Edad] diagnosticado con [Condición, ej. TDAH, Trastorno del Espectro Autista nivel 1, Dislexia].
- Contexto del Aula: [Aula regular con 30 estudiantes].

Instrucciones de Adaptación (PIAR):
1. **Múltiples formas de Representación**: ¿Cómo presento la información visual, auditiva o kinestésicamente para que el estudiante la comprenda sin frustración?
2. **Múltiples formas de Expresión**: Proporcióname 3 alternativas diferentes para que el estudiante me demuestre que aprendió, sin obligarlo a usar métodos tradicionales que choquen con su condición.
3. **Múltiples formas de Implicación**: Sugiere estrategias de motivación y autorregulación emocional específicas para este perfil durante esta actividad.`;
      break;

    case 'convivencia':
      adviceList.push('Define claramente la **Tipología de la Falta** (Tipo 1: leves, Tipo 2: agresión, Tipo 3: delito/bullying grave).');
      adviceList.push('Menciona el uso de la **Ruta de Atención Integral** o manual de convivencia.');
      adviceList.push('Busca siempre un enfoque **Restaurativo**, no solo punitivo.');
      improvedPrompt = `Actúa como un Orientador Escolar, Psicólogo Educativo y Experto en Resolución de Conflictos y Convivencia Escolar.

Tengo la siguiente situación en mi institución: "${promptText.trim()}".

Variables del Caso:
- Edades de los involucrados: [ej. 13 y 14 años].
- Tipología aproximada: [Falta Leve, Agresión Escolar (Bullying), Falta Grave].

Instrucciones de Actuación:
1. Propón un protocolo de actuación paso a paso basado en la Ruta de Atención Integral Escolar (Detección, Atención, Seguimiento).
2. Redacta un guion o enfoque sugerido para la entrevista/mediación con los estudiantes implicados, utilizando técnicas de **Prácticas Restaurativas** y escucha activa.
3. Redacta los puntos clave que debo comunicarle a los padres de familia sin violar el debido proceso escolar ni generar alarma innecesaria.
4. Sugiere una actividad preventiva (charla, dinámica de aula) para evitar que esto vuelva a ocurrir en el grupo.`;
      break;

    case 'rubrica':
      adviceList.push('Basa tu rúbrica en competencias y **Descriptores Cualitativos**, no solo en números.');
      adviceList.push('Usa los niveles de desempeño estándar (Bajo, Básico, Alto, Superior).');
      improvedPrompt = `Actúa como un Auditor de Calidad Educativa. Crea una Rúbrica de Evaluación Analítica en formato de Tabla Markdown para evaluar: "${promptText.trim()}".

Variables:
- Nivel Educativo: [Grado/Edad].
- Dimensiones a Evaluar: [ej. Competencia Argumentativa, Trabajo en Equipo, Dominio del Tema, Presentación].
- Niveles de Desempeño: Superior (Excelente), Alto (Sobresaliente), Básico (Suficiente), Bajo (Insuficiente).

Instrucciones:
1. Para cada cruce entre Dimensión y Nivel, redacta un **Descriptor Cualitativo** exacto. Evita usar adjetivos subjetivos (como "bueno" o "malo"); en su lugar, describe la evidencia observable (ej. "Argumenta usando 3 fuentes verificables").
2. Incluye una columna de ponderación porcentual para cada dimensión (sumando 100%).`;
      break;

    case 'proyecto':
      adviceList.push('Alinea la actividad con la metodología **ABP (Aprendizaje Basado en Proyectos/Problemas)**.');
      adviceList.push('Menciona cuál será el **Producto Final** esperado (feria, maqueta, debate, código).');
      improvedPrompt = `Actúa como un Diseñador Curricular experto en metodologías activas, específicamente Aprendizaje Basado en Proyectos (ABP).

Necesito diseñar un proyecto interdisciplinario basado en: "${promptText.trim()}".

Variables del Proyecto:
- Grados involucrados: [Edades o Grados].
- Materias que se cruzan: [ej. Ciencias, Matemáticas y Lenguaje].
- Duración estimada: [ej. 3 semanas].

Estructura del Proyecto a generar:
1. **Pregunta Orientadora (Driving Question)**: Un desafío abierto y motivador del mundo real.
2. **Producto Final Esperado**: Qué construirán o presentarán los estudiantes.
3. **Cronograma Fase a Fase**: (1. Lanzamiento/Investigación, 2. Desarrollo, 3. Presentación Pública).
4. **Habilidades del Siglo XXI**: Cómo este proyecto evalúa el pensamiento crítico, comunicación, colaboración o creatividad.`;
      break;

    case 'explicacion':
      adviceList.push('Pide el uso de **Andamiaje Cognitivo (Scaffolding)**.');
      adviceList.push('Solicita ejemplos vinculados a la **cultura pop o el entorno local** del estudiante.');
      improvedPrompt = `Actúa como un Profesor y Divulgador Pedagógico excepcional. Tu objetivo es explicar: "${promptText.trim()}".

Instrucciones para la explicación (Andamiaje Cognitivo):
- Público objetivo: Estudiantes de [Edad], que suelen aburrirse con explicaciones tradicionales.
- Hook (Enganche): Inicia con un misterio, una paradoja o un dato increíble de la vida real.
- Conexión Cultural: Usa al menos una metáfora vinculada a [Deportes, Videojuegos, Películas populares, o el entorno de la ciudad del alumno].
- Desglose Conceptual: Divide la teoría dura en 3 puntos fáciles de masticar (micro-learning).
- Verificación: Termina con un "Ticket de Salida" (Exit Ticket): una pregunta reflexiva que el alumno debe responder antes de irse.`;
      break;
      
    case 'reunion':
      adviceList.push('Especifica el objetivo de la reunión (Escuela de padres, Entrega de notas, Comité disciplinario).');
      adviceList.push('Pide a la IA que estructure una **Agenda con control de tiempos**.');
      improvedPrompt = `Actúa como un Facilitador de Reuniones y Gestor Escolar. Diseña la agenda y el acta directiva para la siguiente reunión: "${promptText.trim()}".

Variables:
- Tipo de Reunión: [ej. Entrega de Boletines, Escuela de Padres, Comité de Área].
- Tiempo disponible: [ej. 60 minutos].
- Objetivo crítico: [Qué decisión o mensaje debe quedar 100% claro al terminar].

Instrucciones:
1. Genera una "Agenda Minuto a Minuto" para proyectar en la pantalla, asignando tiempos estrictos a cada bloque (Introducción, Núcleo, Preguntas, Cierre).
2. Redacta un guion introductorio (Icebreaker) para establecer un tono de colaboración y no de queja.
3. Diseña una plantilla de "Acta de Reunión" (con Acuerdos, Responsables y Fechas límite) para llenarla durante el evento.`;
      break;

    default:
      const words = promptText.split(' ').length;
      if (words < 8) {
        adviceList.push('El prompt es demasiado corto. La IA no tiene contexto suficiente del entorno escolar.');
      }
      adviceList.push('Usa la fórmula: [Rol Docente] + [Intención Pedagógica] + [Contexto del salón/estudiantes] + [Modelo Pedagógico].');
      adviceList.push('Siempre usa [Corchetes] para indicar las variables de tu institución que debes llenar.');
      
      improvedPrompt = `Actúa como un [Tu Rol Pedagógico exacto, ej. Orientador, Coordinador Académico, Maestro de Preescolar]. 

Necesito que apliques tu experiencia educativa para desarrollar la siguiente solicitud: "${promptText.trim()}".

Para garantizar la pertinencia académica, integra este contexto:
- Edades/Grado escolar de mis estudiantes: [Grado].
- Objetivo de Aprendizaje / Propósito: [Qué quieres lograr pedagógicamente].
- Particularidades del grupo: [ej. Son muy visuales, hay problemas de disciplina, es un grupo de excelencia].

Entrégame la respuesta estructurada en [Formato deseado: ej. Párrafos, Tabla comparativa, Lista de verificación] y asegúrate de que el tono sea institucional y aplicable de forma realista en el aula escolar de hoy en día.`;
  }

  const finalAdvice = `Para sacarle el máximo provecho a la Inteligencia Artificial en la educación, debes ser un "Ingeniero de Prompts Educativos". Al tuyo le faltan estos detalles críticos:\n\n- ${adviceList.join('\n- ')}`;

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

  res.json({ advice: finalAdvice, improvedPrompt });
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
