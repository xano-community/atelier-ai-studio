// How close a passage must be to count, shared by Ask and by a recipe's pick from Knowledge. Kept apart from ask.ts so a
// run's steps can read it without importing Ask itself.

/** How many passages are fetched by similarity, and how many an answer or a recipe step is written from. */
export const NEAREST = 20;
export const ANSWER_FROM = 6;
/**
 * Cosine distance (1 − similarity) beyond which a passage isn't about the question. Measured on gemini-embedding-2 with a
 * call and a size guide: passages that answered the question sat 0.22 to 0.41 away, and a question about something in
 * neither was 0.47 or more from everything.
 */
export const MOST_DISTANCE = 0.45;
