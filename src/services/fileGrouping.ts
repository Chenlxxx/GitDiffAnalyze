import { FileChange } from './filePriority';

export interface FileGroup {
  name: string;
  description: string;
  files: FileChange[];
}

/**
 * Returns a risk hint based on the file group.
 */
export function getRiskHint(groupName: string): string {
  switch (groupName) {
    case 'Public API / Interface / Types':
      return 'CRITICAL: Changes to public surface area can break downstream consumers.';
    case 'Config / Build / Dependencies':
      return 'HIGH: Configuration changes can affect deployment, security, and runtime behavior.';
    case 'Migration / Release Notes':
      return 'HIGH: Migration logic is prone to data loss or versioning issues.';
    case 'Core Logic / Security / Engine':
      return 'HIGH: Core logic changes have wide-reaching impact on system stability.';
    default:
      return 'MEDIUM: General implementation changes.';
  }
}

/**
 * Returns a review hint based on the file group.
 */
export function getReviewHint(groupName: string): string {
  switch (groupName) {
    case 'Public API / Interface / Types':
      return 'Verify semantic versioning, check for removed exports, and ensure backward compatibility of types.';
    case 'Config / Build / Dependencies':
      return 'Check for sensitive credential leaks, dependency version conflicts, and build pipeline impacts.';
    case 'Migration / Release Notes':
      return 'Review data transformation logic, rollback procedures, and documentation accuracy.';
    case 'Core Logic / Security / Engine':
      return 'Audit for security vulnerabilities, performance regressions, and side effects in critical paths.';
    default:
      return 'Review for logic correctness, code style, and test coverage.';
  }
}

/**
 * Groups changed files by their compatibility risk surface.
 */
export function groupFiles(files: FileChange[]): FileGroup[] {
  const groups: Record<string, FileGroup> = {
    api: {
      name: 'Public API / Interface / Types',
      description: 'Changes to public APIs, interfaces, types, and schemas that directly affect external consumers.',
      files: []
    },
    config: {
      name: 'Config / Build / Dependencies',
      description: 'Changes to configuration files, build scripts, manifests, and dependency definitions.',
      files: []
    },
    migration: {
      name: 'Migration / Release Notes',
      description: 'Files related to version migrations, deprecations, and release documentation.',
      files: []
    },
    core: {
      name: 'Core Logic / Security / Engine',
      description: 'Changes to core business logic, security modules, authentication, and the main engine.',
      files: []
    },
    other: {
      name: 'Other Changes',
      description: 'General implementation changes, UI components, and other non-critical files.',
      files: []
    }
  };

  for (const file of files) {
    const filename = file.filename.toLowerCase();
    
    // 1. Public API / Types
    if (
      filename.includes('api/') || 
      filename.includes('/api') ||
      filename.includes('interface') || 
      filename.includes('types.') || 
      filename.endsWith('.d.ts') ||
      filename.includes('schema') ||
      filename.includes('contract') ||
      filename.includes('export') ||
      filename.includes('model') ||
      filename.endsWith('.proto') ||
      filename.endsWith('.graphql')
    ) {
      groups.api.files.push(file);
      continue;
    }

    // 2. Config / Build
    if (
      filename.includes('package.json') ||
      filename.includes('pom.xml') ||
      filename.includes('go.mod') ||
      filename.includes('config') ||
      filename.includes('settings') ||
      filename.includes('manifest') ||
      filename.includes('build.') ||
      filename.includes('webpack') ||
      filename.includes('vite.config') ||
      filename.endsWith('.yaml') ||
      filename.endsWith('.yml') ||
      filename.endsWith('.toml') ||
      filename.endsWith('.gradle')
    ) {
      groups.config.files.push(file);
      continue;
    }

    // 3. Migration / Release
    if (
      filename.includes('migration') ||
      filename.includes('deprecated') ||
      filename.includes('changelog') ||
      filename.includes('readme') ||
      filename.includes('release') ||
      filename.includes('upgrade') ||
      filename.includes('version')
    ) {
      groups.migration.files.push(file);
      continue;
    }

    // 4. Core / Security
    if (
      filename.includes('core/') ||
      filename.includes('auth/') ||
      filename.includes('security/') ||
      filename.includes('engine/') ||
      filename.includes('kernel/') ||
      filename.includes('main.') ||
      filename.includes('index.') ||
      filename.includes('provider/') ||
      filename.includes('service/')
    ) {
      groups.core.files.push(file);
      continue;
    }

    // 5. Other
    groups.other.files.push(file);
  }

  // Filter out empty groups and return
  return Object.values(groups).filter(g => g.files.length > 0);
}
