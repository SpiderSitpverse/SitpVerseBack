/**
 * Roles del sistema. Viven en el núcleo compartido porque todos los módulos los necesitan
 * (autorización, audiencias de eventos), pero el dueño de los usuarios es `modules/identity`.
 */
export const USER_ROLES = ['ADMIN', 'DRIVER', 'MECHANICAL'] as const;

export type UserRole = (typeof USER_ROLES)[number];
