const COMBINATIONS = [
  {
    id: 'java-spring+jpa-hibernate+uuid',
    providerId: 'java-spring',
    language: 'java',
    framework: 'spring',
    persistenceId: 'jpa-hibernate',
    keyType: 'uuid',
    status: 'legacy-provider',
  },
  {
    id: 'python-fastapi+sqlalchemy-sqlmodel+uuid',
    providerId: 'python-fastapi',
    language: 'python',
    framework: 'fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    status: 'legacy-provider',
  },
  {
    id: 'typescript-express+typeorm+uuid',
    providerId: 'typescript-express',
    language: 'typescript',
    framework: 'express',
    persistenceId: 'typeorm',
    keyType: 'uuid',
    status: 'legacy-provider',
  },
].map((entry) => Object.freeze(entry));

export const APPROVED_COMBINATIONS = Object.freeze(COMBINATIONS);

export function listApprovedCombinations() {
  return APPROVED_COMBINATIONS.map((entry) => ({ ...entry }));
}

export function resolveApprovedCombination({ providerId, persistenceId, keyType }) {
  if (!providerId || !persistenceId || !keyType) return null;
  const found = APPROVED_COMBINATIONS.find((entry) => (
    entry.providerId === providerId
    && entry.persistenceId === persistenceId
    && entry.keyType === keyType
  ));
  return found ? { ...found } : null;
}
