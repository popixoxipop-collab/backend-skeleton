// fixture-pin: typeorm@0.3.31 case: naming-strategy
import { DefaultNamingStrategy } from 'typeorm';

export default class PrefixNamingStrategy extends DefaultNamingStrategy {
	tableName(className: string, customName: string | undefined): string {
		return customName ? customName : 'app_' + className.toLowerCase();
	}

	columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
		return customName ? customName : propertyName.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
	}
}
