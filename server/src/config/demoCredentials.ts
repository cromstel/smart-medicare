/**
 * The credentials the local seed gives the demo accounts.
 *
 * The seeded accounts are how a fresh checkout is exercised, so they have to
 * keep working -- but their passwords were bcrypt hashes written into
 * `server/src/database/seed.sql`, and the plaintext behind them was written
 * into the documentation, the end-to-end specs and a login page. A credential
 * that is in the repository is a credential that is in every clone of it.
 *
 * The passwords are configuration now:
 *
 *   SUPER_ADMIN_PASSWORD        the seeded super administrator
 *   ADMIN_PASSWORD              the seeded hospital administrator
 *   DOCTOR_PASSWORD             the seeded clinician
 *   PATIENT_PASSWORD            the seeded patient
 *   NURSE_PASSWORD              the seeded nurse
 *   PHARMACIST_PASSWORD         the seeded pharmacist
 *   LAB_TECHNICIAN_PASSWORD     the seeded lab technician
 *   HOSPITAL_MANAGEMENT_PASSWORD the seeded hospital manager
 *   RECEPTIONIST_PASSWORD       the seeded receptionist
 *   BILLING_SPECIALIST_PASSWORD the seeded billing specialist
 *   INSURANCE_COORDINATOR_PASSWORD the seeded insurance coordinator
 *   MEDICAL_RECORDS_CLERK_PASSWORD the seeded medical records clerk
 *   RADIOLOGY_TECHNICIAN_PASSWORD the seeded radiology technician
 *
 * The seed runner hashes whatever these resolve to and substitutes the hashes
 * into the seed file, so no hash and no password is stored in the repository.
 * The end-to-end suite reads the same values through this module, which is
 * why it is dependency-free: the front-end package has neither `dotenv` nor
 * `bcryptjs`, and the module has to be importable from there.
 *
 * `SUPER_ADMIN_PASSWORD` and `ADMIN_PASSWORD` are accepted as aliases for the
 * two privileged accounts, because that is what an existing deployment
 * already sets.
 */

/** The demo accounts the local seed creates. */
export type DemoAccountId = 'superAdmin' | 'admin' | 'doctor' | 'patient' | 'nurse' | 'pharmacist' | 'labTechnician' | 'hospitalManagement' | 'receptionist' | 'billingSpecialist' | 'insuranceCoordinator' | 'medicalRecordsClerk' | 'radiologyTechnician';

export interface DemoAccount {
  /** Identifier used to look the account up in the resolved credential map. */
  id: DemoAccountId;
  /** The environment variable that supplies the password. */
  envVar: string;
  /** Variables that also supply the password, for compatibility with older setups. */
  aliasEnvVars: readonly string[];
  /** The token the seed file carries where the password hash goes. */
  hashPlaceholder: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: 'superAdmin',
    envVar: 'SUPER_ADMIN_PASSWORD',
    aliasEnvVars: ['SUPER_ADMIN_PASSWORD', 'super_ADMIN_PASSWORD'],
    hashPlaceholder: 'SUPER_ADMIN_PASSWORD_HASH',
  },
  {
    id: 'admin',
    envVar: 'ADMIN_PASSWORD',
    aliasEnvVars: ['ADMIN_PASSWORD'],
    hashPlaceholder: 'ADMIN_PASSWORD_HASH',
  },
  {
    id: 'doctor',
    envVar: 'DOCTOR_PASSWORD',
    aliasEnvVars: ['DOCTOR_PASSWORD'],
    hashPlaceholder: 'DOCTOR_PASSWORD_HASH',
  },
  {
    id: 'patient',
    envVar: 'PATIENT_PASSWORD',
    aliasEnvVars: ['PATIENT_PASSWORD'],
    hashPlaceholder: 'PATIENT_PASSWORD_HASH',
  },
  {
    id: 'nurse',
    envVar: 'NURSE_PASSWORD',
    aliasEnvVars: ['NURSE_PASSWORD'],
    hashPlaceholder: 'NURSE_PASSWORD_HASH',
  },
  {
    id: 'pharmacist',
    envVar: 'PHARMACIST_PASSWORD',
    aliasEnvVars: ['PHARMACIST_PASSWORD'],
    hashPlaceholder: 'PHARMACIST_PASSWORD_HASH',
  },
  {
    id: 'labTechnician',
    envVar: 'LAB_TECHNICIAN_PASSWORD',
    aliasEnvVars: ['LAB_TECHNICIAN_PASSWORD'],
    hashPlaceholder: 'LAB_TECHNICIAN_PASSWORD_HASH',
  },
  {
    id: 'hospitalManagement',
    envVar: 'HOSPITAL_MANAGEMENT_PASSWORD',
    aliasEnvVars: ['HOSPITAL_MANAGEMENT_PASSWORD'],
    hashPlaceholder: 'HOSPITAL_MANAGEMENT_PASSWORD_HASH',
  },
  {
    id: 'receptionist',
    envVar: 'RECEPTIONIST_PASSWORD',
    aliasEnvVars: ['RECEPTIONIST_PASSWORD'],
    hashPlaceholder: 'RECEPTIONIST_PASSWORD_HASH',
  },
  {
    id: 'billingSpecialist',
    envVar: 'BILLING_SPECIALIST_PASSWORD',
    aliasEnvVars: ['BILLING_SPECIALIST_PASSWORD'],
    hashPlaceholder: 'BILLING_SPECIALIST_PASSWORD_HASH',
  },
  {
    id: 'insuranceCoordinator',
    envVar: 'INSURANCE_COORDINATOR_PASSWORD',
    aliasEnvVars: ['INSURANCE_COORDINATOR_PASSWORD'],
    hashPlaceholder: 'INSURANCE_COORDINATOR_PASSWORD_HASH',
  },
  {
    id: 'medicalRecordsClerk',
    envVar: 'MEDICAL_RECORDS_CLERK_PASSWORD',
    aliasEnvVars: ['MEDICAL_RECORDS_CLERK_PASSWORD'],
    hashPlaceholder: 'MEDICAL_RECORDS_CLERK_PASSWORD_HASH',
  },
  {
    id: 'radiologyTechnician',
    envVar: 'RADIOLOGY_TECHNICIAN_PASSWORD',
    aliasEnvVars: ['RADIOLOGY_TECHNICIAN_PASSWORD'],
    hashPlaceholder: 'RADIOLOGY_TECHNICIAN_PASSWORD_HASH',
  },
];

/**
 * The password for a demo account, taken from the environment.
 *
 * Falls back to the shared development password when the account's variable
 * (and its aliases) are unset.
 */
export const resolveDemoPassword = (account: DemoAccount): string => {
  for (const name of [account.envVar, ...account.aliasEnvVars]) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  throw new Error(
    `No password configured for ${account.id}: set ${account.envVar} (or one of ${account.aliasEnvVars.join(', ')}) before seeding or running the tests.`
  );
};

/** Every demo account's password, keyed by account id. */
export const resolveDemoCredentials = (): Record<DemoAccountId, string> => {
  const credentials = {} as Record<DemoAccountId, string>;
  for (const account of DEMO_ACCOUNTS) {
    credentials[account.id] = resolveDemoPassword(account);
  }
  return credentials;
};

/**
 * Where a demo account's password came from, named for a log line.
 *
 * The variable name is safe to print; the value is not.
 */
export const resolveDemoPasswordSource = (account: DemoAccount): string => {
  for (const name of [account.envVar, ...account.aliasEnvVars]) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return name;
    }
  }
  return 'unset (must be configured)';
};

/** The placeholder token the seed file carries for a password hash. */
const HASH_PLACEHOLDER = /\$\{(SEED_[A-Z_]+_PASSWORD_HASH)\}/g;

/**
 * Replaces the password placeholders in the seed file with real hashes.
 *
 * Throws when a placeholder has no hash, so a seed can never quietly write
 * the literal token into the `users` table.
 */
export const applySeedPasswordHashes = (
  sql: string,
  hashes: Readonly<Record<string, string>>
): string => {
  const missing: string[] = [];
  const rendered = sql.replace(HASH_PLACEHOLDER, (_match, placeholder: string) => {
    const hash = hashes[placeholder];
    if (!hash) {
      missing.push(placeholder);
      return _match;
    }
    return hash;
  });

  if (missing.length > 0) {
    throw new Error(
      `The seed file expects a password hash for: ${missing.join(', ')}. ` +
        'Every seeded account must be given a hash.'
    );
  }

  return rendered;
};
