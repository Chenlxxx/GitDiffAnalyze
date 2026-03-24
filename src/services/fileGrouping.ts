export type FileGroupType = 'API_TYPES' | 'CONFIG_BUILD' | 'MIGRATION' | 'CORE_SECURITY' | 'GENERAL';

export interface FileGroup {
  type: FileGroupType;
  name: string;
  files: any[];
  priority: number;
}

export const FILE_GROUPS: Record<FileGroupType, { name: string, priority: number }> = {
  API_TYPES: { name: 'Public API / Types / Schema', priority: 100 },
  MIGRATION: { name: 'Migration / Deprecation / Release Notes', priority: 90 },
  CORE_SECURITY: { name: 'Core / Auth / Security / Engine', priority: 80 },
  CONFIG_BUILD: { name: 'Config / Build / Manifest', priority: 70 },
  GENERAL: { name: 'General Code Changes', priority: 50 },
};

export function groupFiles(files: any[]): FileGroup[] {
  const groups: Record<FileGroupType, any[]> = {
    API_TYPES: [],
    MIGRATION: [],
    CORE_SECURITY: [],
    CONFIG_BUILD: [],
    GENERAL: [],
  };

  files.forEach(file => {
    const filename = file.filename.toLowerCase();
    
    // API / Types / Schema
    if (
      filename.includes('api') || 
      filename.includes('interface') || 
      filename.includes('types') || 
      filename.includes('schema') ||
      filename.includes('export') ||
      filename.endsWith('.d.ts') ||
      filename.includes('swagger') ||
      filename.includes('openapi')
    ) {
      groups.API_TYPES.push(file);
    }
    // Migration / Deprecation
    else if (
      filename.includes('migration') || 
      filename.includes('deprecation') || 
      filename.includes('changelog') || 
      filename.includes('release-notes') ||
      filename.includes('upgrade')
    ) {
      groups.MIGRATION.push(file);
    }
    // Core / Auth / Security
    else if (
      filename.includes('core') || 
      filename.includes('auth') || 
      filename.includes('security') || 
      filename.includes('engine') ||
      filename.includes('permission') ||
      filename.includes('crypto')
    ) {
      groups.CORE_SECURITY.push(file);
    }
    // Config / Build / Manifest
    else if (
      filename.includes('config') || 
      filename.includes('settings') || 
      filename.includes('build') || 
      filename.includes('manifest') ||
      filename.includes('package.json') ||
      filename.includes('pom.xml') ||
      filename.includes('gradle') ||
      filename.includes('dockerfile') ||
      filename.includes('.env') ||
      filename.endsWith('.yaml') ||
      filename.endsWith('.yml') ||
      filename.endsWith('.json') && (filename.includes('tsconfig') || filename.includes('package'))
    ) {
      groups.CONFIG_BUILD.push(file);
    }
    // General
    else {
      groups.GENERAL.push(file);
    }
  });

  return (Object.keys(groups) as FileGroupType[])
    .map(type => ({
      type,
      name: FILE_GROUPS[type].name,
      files: groups[type],
      priority: FILE_GROUPS[type].priority
    }))
    .filter(group => group.files.length > 0)
    .sort((a, b) => b.priority - a.priority);
}
