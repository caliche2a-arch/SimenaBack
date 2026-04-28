const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@libsql/client');
const { PrismaLibSql } = require('@prisma/adapter-libsql');

const prisma = new PrismaClient({ 
  adapter: new PrismaLibSql({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
});

async function main() {
  const subjects = ['Matematicas', 'Historia', 'Religion', 'Quimica'];
  const levels = ['Primaria', 'Secundaria'];
  const categories = ['Explicación', 'Ejercicios', 'Lección', 'Narrativa', 'Actividad', 'Evaluación', 'Debate'];

  const prompts = [];

  // Base templates to combine
  const templates = {
    Matematicas: {
      Primaria: [
        "Actúa como un profesor muy didáctico. Explica {topic} usando objetos cotidianos para niños de 8 años.",
        "Crea un juego de roles matemático donde los niños tengan que usar {topic} para comprar en un supermercado imaginario.",
        "Diseña 5 problemas de palabras muy sencillos y divertidos sobre {topic}.",
        "Inventa un cuento corto donde el protagonista necesite entender {topic} para salvar a su mascota.",
        "Genera una actividad visual para colorear que enseñe {topic} paso a paso."
      ],
      Secundaria: [
        "Actúa como un tutor experto. Diseña una guía de estudio intensiva sobre {topic} para adolescentes, incluyendo ejercicios resueltos.",
        "Explica la aplicación en la vida real y la historia detrás de {topic}.",
        "Crea un examen de opción múltiple de 10 preguntas sobre {topic} con un nivel de dificultad progresivo.",
        "Plantea un desafío lógico o acertijo complejo que se resuelva usando {topic}.",
        "Genera una rúbrica de evaluación para un proyecto donde los estudiantes deben aplicar {topic} para construir un modelo."
      ]
    },
    Historia: {
      Primaria: [
        "Escribe un cuento interactivo sobre {topic} donde los niños puedan tomar decisiones como si estuvieran en esa época.",
        "Haz un resumen tipo cómic (describiendo las viñetas) sobre los eventos más importantes de {topic}.",
        "Crea una canción infantil pegadiza para memorizar las fechas clave de {topic}.",
        "Dime 5 curiosidades muy divertidas y poco conocidas sobre {topic} para sorprender a niños de 10 años.",
        "Diseña una manualidad sencilla que los estudiantes puedan hacer relacionada con {topic}."
      ],
      Secundaria: [
        "Actúa como un historiador. Genera un debate con dos posturas opuestas sobre las consecuencias de {topic}.",
        "Crea un análisis profundo de las causas políticas y económicas que llevaron a {topic}.",
        "Diseña un proyecto de investigación paso a paso sobre {topic} para estudiantes de secundaria.",
        "Escribe un ensayo simulado desde la perspectiva de una figura histórica involucrada en {topic}.",
        "Genera una línea de tiempo detallada y analítica sobre los eventos de {topic}."
      ]
    },
    Religion: {
      Primaria: [
        "Explica el valor de {topic} a través de una fábula con animales que hablan.",
        "Crea una actividad grupal donde los niños actúen una situación que demuestre {topic}.",
        "Escribe una oración o reflexión matutina sencilla relacionada con {topic}.",
        "Diseña un árbol de compromisos donde las ramas representen acciones sobre {topic}.",
        "Genera un juego de emparejar tarjetas con buenas acciones relacionadas con {topic}."
      ],
      Secundaria: [
        "Actúa como un profesor de ética y religión. Plantea un dilema moral complejo para adolescentes basado en {topic}.",
        "Proporciona un análisis reflexivo sobre cómo {topic} se aplica a los problemas modernos de las redes sociales.",
        "Diseña un foro de discusión para que los estudiantes compartan sus puntos de vista sobre {topic}.",
        "Escribe un análisis comparativo de cómo diferentes culturas o religiones abordan {topic}.",
        "Genera una guía de introspección con preguntas profundas sobre el papel de {topic} en la vida diaria."
      ]
    },
    Quimica: {
      Primaria: [
        "Explica {topic} como si fuera una receta mágica o un experimento de cocina seguro para niños.",
        "Crea un cuento sobre una gota de agua que viaja y aprende sobre {topic}.",
        "Diseña un experimento casero muy seguro y visual para demostrar {topic}.",
        "Genera una tabla simple comparando elementos cotidianos relacionados con {topic}.",
        "Inventa una canción divertida sobre los estados de la materia y {topic}."
      ],
      Secundaria: [
        "Actúa como un científico. Redacta un informe de laboratorio simulado sobre {topic}.",
        "Explica a nivel atómico y molecular cómo ocurre exactamente {topic}, usando un lenguaje técnico pero accesible.",
        "Crea una serie de 10 problemas estequiométricos o teóricos sobre {topic} con sus respectivas soluciones.",
        "Plantea un escenario de desastre ambiental y pide a los estudiantes que usen {topic} para proponer una solución.",
        "Genera un juego de mesa educativo (reglas y dinámica) enfocado en aprender {topic}."
      ]
    }
  };

  const topics = {
    Matematicas: { Primaria: ['Suma y Resta', 'Fracciones', 'Tablas de Multiplicar', 'Geometría Básica', 'El Reloj y el Tiempo'], Secundaria: ['Ecuaciones Cuadráticas', 'Trigonometría', 'Estadística y Probabilidad', 'Cálculo Básico', 'Álgebra Lineal'] },
    Historia: { Primaria: ['El Descubrimiento de América', 'Los Dinosaurios', 'El Antiguo Egipto', 'La Revolución Industrial (simplificada)', 'Nuestra Independencia'], Secundaria: ['La Segunda Guerra Mundial', 'La Guerra Fría', 'La Revolución Francesa', 'El Renacimiento', 'La caída del Imperio Romano'] },
    Religion: { Primaria: ['El Respeto', 'La Solidaridad', 'Parábola del Buen Samaritano', 'La Amistad', 'El Perdón'], Secundaria: ['Ética Digital', 'Dilemas Morales Modernos', 'Historia de las Religiones', 'Filosofía y Fe', 'Justicia Social'] },
    Quimica: { Primaria: ['Los Estados del Agua', 'Mezclas y Soluciones', 'El Ciclo del Agua', 'Materiales Reciclables', 'Aire y Oxígeno'], Secundaria: ['Tabla Periódica', 'Enlaces Químicos', 'Termodinámica', 'Química Orgánica', 'Reacciones Ácido-Base'] }
  };

  // Generate prompts programmatically
  subjects.forEach(subject => {
    levels.forEach(level => {
      const subjectTopics = topics[subject][level];
      const subjectTemplates = templates[subject][level];
      
      // Create exactly 15 prompts (5 templates * 3 variations each or combinations)
      for (let i = 0; i < 15; i++) {
        const topic = subjectTopics[i % subjectTopics.length];
        const template = subjectTemplates[i % subjectTemplates.length];
        const category = categories[i % categories.length];
        
        prompts.push({
          title: `${category} sobre ${topic}`,
          content: template.replace('{topic}', topic),
          subject: subject,
          level: level,
          category: category
        });
      }
    });
  });

  console.log(`Iniciando el sembrado de ${prompts.length} prompts masivos...`);

  // Clear existing prompts
  await prisma.prompt.deleteMany({});

  for (const prompt of prompts) {
    await prisma.prompt.create({
      data: prompt
    });
  }

  console.log('Sembrado completado con éxito.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
