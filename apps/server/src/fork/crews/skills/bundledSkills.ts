import { BUNDLED_SKILLS } from "./bundledSkills.gen.ts";

/** A file of a bundled T3 skill, or null. Edit `<name>/SKILL.md`, then run `scripts/fork/generate-crew-skills.ts`. */
export function bundledSkill(name: string, file = "SKILL.md") {
  const files = Object.hasOwn(BUNDLED_SKILLS, name) ? BUNDLED_SKILLS[name] : undefined;
  const content = files && Object.hasOwn(files, file) ? files[file] : undefined;
  return content === undefined ? null : { name, file, content };
}

export const bundledSkillNames = () => Object.keys(BUNDLED_SKILLS);
