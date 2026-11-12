package example.scope.composite;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.util.Objects;

@Embeddable
class InvoiceKey implements Serializable {
    @Column(name = "tenant_id")
    String tenantId;

    @Column(name = "invoice_id")
    Long invoiceId;

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof InvoiceKey key)) return false;
        return Objects.equals(tenantId, key.tenantId) && Objects.equals(invoiceId, key.invoiceId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(tenantId, invoiceId);
    }
}

// The bridge's single idField cannot represent an ordered two-column key.
@Entity
@Table(name = "invoices")
class CompositeInvoice {
    @EmbeddedId
    InvoiceKey id;
}
