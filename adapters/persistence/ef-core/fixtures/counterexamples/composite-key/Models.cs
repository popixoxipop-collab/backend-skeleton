using Microsoft.EntityFrameworkCore;

namespace T00.EfCorePlan.CompositeKey;

public sealed class Membership
{
    public string TenantId { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Role { get; set; } = "";
}

public sealed class MembershipContext : DbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Membership>().HasKey(item => new { item.TenantId, item.UserId });
    }
}
