package example.scope.tenant;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.Session;
import org.hibernate.SessionFactory;
import org.hibernate.context.spi.CurrentTenantIdentifierResolver;
import java.util.function.Supplier;

@Entity
@Table(name = "invoices") // No fixed physical schema is justified by source alone.
class TenantInvoice {
    @Id
    Long id;
}

class RequiredTenant implements CurrentTenantIdentifierResolver<String> {
    private final Supplier<String> currentTenant;

    RequiredTenant(Supplier<String> currentTenant) {
        this.currentTenant = currentTenant;
    }

    @Override
    public String resolveCurrentTenantIdentifier() {
        String tenant = currentTenant.get();
        if (tenant == null || tenant.isBlank()) throw new IllegalStateException("tenant required");
        return tenant;
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return true;
    }
}

class TenantSessions {
    Session open(SessionFactory factory, String tenant) {
        return factory.withOptions().tenantIdentifier(tenant).openSession();
    }
}
