package example.scope.naming;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.boot.model.naming.Identifier;
import org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl;
import org.hibernate.engine.jdbc.env.spi.JdbcEnvironment;
import java.util.Locale;

@Entity
@Table(name = "InvoiceRecord")
class InvoiceRecord {
    @Id
    Long id;
}

// Even an explicit logical @Table name can be transformed by this runtime configuration.
// This example is not installed in a SessionFactory in this scope.
class TenantPrefixNamingStrategy extends PhysicalNamingStrategyStandardImpl {
    @Override
    public Identifier toPhysicalTableName(Identifier logicalName, JdbcEnvironment jdbcEnvironment) {
        return Identifier.toIdentifier(
            "tenant_" + logicalName.getText().toLowerCase(Locale.ROOT), logicalName.isQuoted());
    }
}
