package example.scope.property;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;

// @Id on a getter selects property access: field-only scanning is not a model oracle.
@Entity
class PropertyAccessRecord {
    private Long id;
    private String displayName;

    @Id
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    @Column(name = "display_name")
    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }
}
