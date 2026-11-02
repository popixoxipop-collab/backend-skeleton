using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;

namespace T00.EfCorePlan.ShadowForeignKey;

public sealed class Principal
{
    public long Id { get; set; }
    public List<Dependent> Dependents { get; set; } = new();
}

public sealed class Dependent
{
    public long Id { get; set; }
    public Principal Principal { get; set; } = null!;
}

// PrincipalId is a shadow property, not a CLR field declaration.
public sealed class ShadowContext : DbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Dependent>()
            .HasOne(item => item.Principal)
            .WithMany(item => item.Dependents)
            .HasForeignKey("PrincipalId");
    }
}
